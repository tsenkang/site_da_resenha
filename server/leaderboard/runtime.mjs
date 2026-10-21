import mysql from 'mysql2/promise';
import { createRequestDatabase, databaseStream, DATABASE_CONCURRENCY } from './request-database.mjs';
import { assertDatabaseEnvironment, assertDatabaseReady, databaseName, PROTOCOL_VERSION, SCHEMA_VERSION } from './deployment-contract.mjs';
import { createLeaderboardService, fail } from './service.mjs';
import { createLeaderboardRest, send, prefix } from './rest.mjs';

import { validateLeaderboardConfig } from './config.mjs';
// One instance is mounted in the project's existing HTTP app. No listener here.
export function createLeaderboardRuntime(config, { databaseUrl = process.env.DATABASE_URL, readonly = process.env.GAME_LEADERBOARD_READ_ONLY === '1' } = {}) {
  validateLeaderboardConfig(config);
  databaseName(databaseUrl);
  const pool = mysql.createPool({ uri: databaseUrl, stream: databaseStream(databaseUrl), connectionLimit: DATABASE_CONCURRENCY, waitForConnections: false, connectTimeout: 3000, timezone: 'Z', dateStrings: true });
  const db = createRequestDatabase(pool);
  const namespace = 'production';
  const service = createLeaderboardService(db, namespace);
  const check = () => assertDatabaseEnvironment(db, namespace);
  async function ready() {
    await assertDatabaseReady(db, namespace, { api: { protocolVersion: PROTOCOL_VERSION }, database: { schemaVersion: SCHEMA_VERSION }, boards: config.boards });
    if (config.identity === 'account') await db.execute('SELECT namespace,user_id,player_id FROM game_lb_accounts LIMIT 0');
    return { status: 'ok', namespace, readonly, protocolVersion: PROTOCOL_VERSION, schemaVersion: SCHEMA_VERSION };
  }
  const rest = createLeaderboardRest(service, { ready, check, readonly, guestWrites: config.identity === 'guest' });
  return {
    config,
    async run(ctx, write, operation) {
      if (ctx.req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'cross_origin_request');
      if (write && readonly) fail(403, 'leaderboard_read_only');
      return db.run(ctx.req, ctx.res, async () => { await check(); return operation(service); });
    },
    middleware(req, res, next) {
      let pathname;
      try { pathname = new URL(req.url, 'http://game-api').pathname; }
      catch { send(res, 400, { error: 'invalid_url' }); return; }
      if (!pathname.startsWith(`${prefix}/`)) return next();
      db.run(req, res, () => rest(req, res)).catch(error => {
        send(res, error.status || 503, { error: error.status && error.code ? error.code : 'leaderboard_unavailable' });
        if (!req.complete) res.once('finish', () => req.destroy());
      });
    },
    close: () => pool.end(),
  };
}
