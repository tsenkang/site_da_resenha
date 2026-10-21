import { AsyncLocalStorage } from 'node:async_hooks';
import net from 'node:net';

export const DATABASE_CONCURRENCY = 8;

const contexts = new AsyncLocalStorage();
const timeoutError = () => Object.assign(new Error('request_timeout'), { status: 504, code: 'request_timeout' });
const busyError = () => Object.assign(new Error('leaderboard_busy'), { status: 503, code: 'leaderboard_busy' });

// mysql2 clears connectTimeout on its first packet; own the full handshake deadline.
export function databaseStream(databaseUrl) {
  const url = new URL(databaseUrl);
  return () => {
    const scope = contexts.getStore();
    if (!scope || scope.cancelled) throw timeoutError();
    const socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 3306) });
    const timer = setTimeout(() => socket.destroy(timeoutError()), 3000);
    scope.connecting.set(socket, timer);
    return socket;
  };
}
function discard(connection) {
  // mysql2 destroy() removes the pool lease but only calls stream.end().
  // Supplying an error to the hard close also rejects pending driver commands.
  const stream = connection.connection.stream;
  connection.destroy();
  stream.destroy(timeoutError());
}

/** A request owns every acquired connection until release; cancellation destroys it. */
export function createRequestDatabase(pool) {
  let active = 0;
  function current() {
    const scope = contexts.getStore();
    if (!scope || scope.cancelled) throw timeoutError();
    return scope;
  }
  async function acquire() {
    const scope = current();
    let connection;
    try { connection = await pool.getConnection(); }
    finally {
      for (const [socket, timer] of scope.connecting) {
        clearTimeout(timer);
        if (!connection) socket.destroy(timeoutError());
      }
      scope.connecting.clear();
    }
    if (scope.cancelled) { discard(connection); throw timeoutError(); }
    scope.connections.add(connection);
    return { scope, connection };
  }
  function release({ scope, connection }) {
    const owned = scope.connections.delete(connection);
    if (owned && !scope.cancelled) connection.release();
  }
  const bounded = connection => ({
    async execute(sql, args) { current(); const result = await connection.execute(sql, args); current(); return result; },
    async query(sql, args) { current(); const result = await connection.query(sql, args); current(); return result; },
  });
  async function command(method, sql, args) {
    const lease = await acquire();
    try { return await bounded(lease.connection)[method](sql, args); } finally { release(lease); }
  }
  return {
    execute: (sql, args) => command('execute', sql, args),
    query: (sql, args) => command('query', sql, args),
    async transaction(fn, { repeatableRead = false } = {}) {
      const lease = await acquire();
      try {
        current();
        // Apply only to the next transaction, without changing the pooled
        // connection's session default for rate limits or score settlement.
        if (repeatableRead) {
          await lease.connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          current();
        }
        await lease.connection.beginTransaction();
        current();
        const result = await fn(bounded(lease.connection));
        current();
        await lease.connection.commit();
        current();
        return result;
      } catch (error) {
        // A disconnected transaction is rolled back when the database detects the close.
        if (!lease.scope.cancelled) {
          try { await lease.connection.rollback(); } catch { discard(lease.connection); lease.scope.connections.delete(lease.connection); throw error; }
        }
        throw error;
      } finally { release(lease); }
    },
    async run(req, res, fn) {
      if (active >= DATABASE_CONCURRENCY) throw busyError();
      active++;
      const scope = { cancelled: false, connections: new Set(), connecting: new Map() };
      let timer;
      let rejectCancelled;
      const cancel = () => {
        if (scope.cancelled) return;
        scope.cancelled = true;
        for (const [socket, timer] of scope.connecting) { clearTimeout(timer); socket.destroy(timeoutError()); }
        scope.connecting.clear();
        for (const connection of scope.connections) discard(connection);
        scope.connections.clear();
        rejectCancelled(timeoutError());
      };
      const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
      const closed = () => { if (!res.writableEnded) cancel(); };
      req.once('aborted', cancel);
      res.once('close', closed);
      timer = setTimeout(cancel, 8000);
      try { return await Promise.race([contexts.run(scope, fn), cancelled]); }
      finally {
        clearTimeout(timer);
        req.removeListener('aborted', cancel);
        res.removeListener('close', closed);
        active--;
      }
    },
  };
}
