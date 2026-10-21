import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { previousSubmission, assertClientRules, assertRunRules, PROTOCOL_VERSION } from './deployment-contract.mjs';
export const fail = (status, code) => {
  throw Object.assign(new Error(code), { status, code });
};
export const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
export const uuidPattern = /^[0-9a-f-]{36}$/;
const digest = (value) => createHash('sha256').update(value).digest('hex');

// Both transports share transactions, validation, receipts and quotas.
export function createLeaderboardService(db, namespace = 'production') {
  async function rateLimit(key, maximum) {
    const bucket = digest(key);
    const window = Math.floor(Date.now() / 60_000);
    const count = await db.transaction(async (conn) => {
      await conn.execute(
        'INSERT IGNORE INTO game_lb_rate_limits (namespace,bucket_hash,window_start,request_count) VALUES (?, ?, ?, 0)',
        [namespace, bucket, window],
      );
      const [[row]] = await conn.execute(
        'SELECT window_start, request_count FROM game_lb_rate_limits WHERE namespace=? AND bucket_hash=? FOR UPDATE',
        [namespace, bucket],
      );
      const next = Number(row.window_start) === window ? Math.min(Number(row.request_count) + 1, 4294967295) : 1;
      await conn.execute(
        'UPDATE game_lb_rate_limits SET window_start=?, request_count=? WHERE namespace=? AND bucket_hash=?',
        [window, next, namespace, bucket],
      );
      return next;
    });
    if (count > maximum) fail(429, 'rate_limited');
  }
  async function identity(authorization, required = true) {
    const auth = authorization || '';
    if (!auth && !required) return null;
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) fail(401, 'guest_session_required');
    const [[player]] = await db.execute(
      'SELECT id, display_name FROM game_lb_players WHERE namespace=? AND token_hash=? AND expires_at>UTC_TIMESTAMP(3)',
      [namespace, digest(auth.slice(7))],
    );
    if (!player) fail(401, 'guest_session_expired');
    await rateLimit(`player:${player.id}`, 120);
    return player;
  }
  async function board(conn, id) {
    const [[value]] = await conn.execute('SELECT * FROM game_lb_boards WHERE namespace=? AND id=?', [namespace, id]);
    if (!value) fail(404, 'board_not_found');
    if (
      !['asc', 'desc'].includes(value.direction) ||
      !value.rules_version ||
      Number(value.min_score) < -1e9 ||
      Number(value.max_score) > 1e9 ||
      Number(value.min_score) > Number(value.max_score)
    )
      fail(503, 'board_configuration_invalid');
    return value;
  }

  async function account(user, create = true) {
    if (!Number.isSafeInteger(user?.id) || user.id < 1 || user.id > 2147483647) fail(401, 'account_session_required');
    await rateLimit(`account:${user.id}`, 120);
    if (!create) {
      const [[player]] = await db.execute(
        'SELECT p.id,p.display_name FROM game_lb_accounts a JOIN game_lb_players p ON p.namespace=a.namespace AND p.id=a.player_id WHERE a.namespace=? AND a.user_id=?',
        [namespace, user.id],
      );
      return player || null;
    }
    return db.transaction(async (conn) => {
      const candidate = randomUUID();
      // The unique account key locks simultaneous first logins, including across Pods.
      await conn.execute(
        'INSERT INTO game_lb_accounts (namespace,user_id,player_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE user_id=user_id',
        [namespace, user.id, candidate],
      );
      const [[mapping]] = await conn.execute(
        'SELECT player_id FROM game_lb_accounts WHERE namespace=? AND user_id=? FOR UPDATE',
        [namespace, user.id],
      );
      if (mapping.player_id === candidate) {
        const name =
          [
            ...String(user.name || 'Player')
              .replace(/[\u0000-\u001f\u007f]/g, '')
              .trim(),
          ]
            .slice(0, 48)
            .join('') || 'Player';
        // No recoverable guest credential exists for an account-owned player.
        await conn.execute(
          'INSERT INTO game_lb_players (namespace,id,display_name,token_hash,expires_at) VALUES (?,?,?,?,UTC_TIMESTAMP(3))',
          [namespace, candidate, name, digest(randomBytes(32))],
        );
      }
      // A concurrent winner can commit after this TiDB transaction's snapshot.
      // Read the player at the same current-read boundary as its locked mapping.
      const [[player]] = await conn.execute('SELECT id,display_name FROM game_lb_players WHERE namespace=? AND id=? FOR UPDATE', [
        namespace,
        mapping.player_id,
      ]);
      if (!player) fail(503, 'account_player_missing');
      return player;
    });
  }
  async function createGuest(data) {
    await rateLimit('global:guests', 300);
    if (
      typeof data.displayName !== 'string' ||
      !data.displayName.trim() ||
      [...data.displayName].length > 48 ||
      /[\u0000-\u001f\u007f]/.test(data.displayName)
    )
      fail(400, 'invalid_display_name');
    const token = randomBytes(32).toString('base64url');
    const playerId = randomUUID();
    await db.execute(
      'INSERT INTO game_lb_players (namespace,id,display_name,token_hash,expires_at) VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 DAY))',
      [namespace, playerId, data.displayName.trim(), digest(token)],
    );
    return { playerId, token, expiresInSeconds: 2592000 };
  }
  async function list(boardId, limit = 20, player = null) {
    // Entries, own best and ordinal must share one snapshot, even while a run
    // commits between queries. These plain reads never lock out score submissions.
    return db.transaction(async (conn) => {
      const rules = await board(conn, boardId);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'invalid_limit');
      const [entries] = await conn.query(
        `SELECT b.player_id AS playerId,p.display_name AS displayName,b.score,b.achieved_at AS achievedAt FROM game_lb_best b JOIN game_lb_players p ON p.namespace=b.namespace AND p.id=b.player_id WHERE b.namespace=? AND b.board_id=? ORDER BY b.rank_value,b.achieved_at,b.player_id LIMIT ?`,
        [namespace, boardId, limit],
      );
      let myRank = null;
      if (player) {
        const [[own]] = await conn.execute('SELECT * FROM game_lb_best WHERE namespace=? AND board_id=? AND player_id=?', [
          namespace,
          boardId,
          player.id,
        ]);
        if (own) {
          const [[rank]] = await conn.execute(
            'SELECT COUNT(*)+1 AS ordinal FROM game_lb_best WHERE namespace=? AND board_id=? AND (rank_value<? OR (rank_value=? AND (achieved_at<? OR (achieved_at=? AND player_id<?))))',
            [namespace, boardId, own.rank_value, own.rank_value, own.achieved_at, own.achieved_at, player.id],
          );
          myRank = { rank: Number(rank.ordinal), score: Number(own.score) };
        }
      }
      return {
        namespace,
        boardId,
        rulesVersion: rules.rules_version,
        trust: 'client_reported',
        entries: entries.map((e, i) => ({ ...e, score: Number(e.score), rank: i + 1 })),
        myRank,
      };
    }, { repeatableRead: true });
  }
  async function beginRun(boardId, player, data) {
    if (
      data.releaseSha !== undefined &&
      (typeof data.releaseSha !== 'string' || !/^[a-f0-9]{7,64}$/.test(data.releaseSha))
    )
      fail(400, 'invalid_release_sha');
    const rules = await board(db, boardId);
    if (!rules.open) fail(409, 'board_closed');
    assertClientRules(data, rules);
    const runId = randomUUID();
    await db.execute(
      'INSERT INTO game_lb_runs (namespace,id,player_id,board_id,issued_at,expires_at,release_sha,rules_version,protocol_version) VALUES (?,?,?,?,UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 MINUTE),?,?,?)',
      [namespace, runId, player.id, boardId, data.releaseSha ?? null, rules.rules_version, PROTOCOL_VERSION],
    );
    return { runId, expiresInSeconds: 1800, rulesVersion: rules.rules_version, protocolVersion: PROTOCOL_VERSION };
  }
  async function submitRun(runId, player, data) {
    if (
      !Number.isSafeInteger(data.score) ||
      Math.abs(data.score) > 1e9 ||
      !Number.isSafeInteger(data.durationMs) ||
      data.durationMs < 0 ||
      data.durationMs > 1800000
    )
      fail(400, 'invalid_score');
    const submissionHash = digest(JSON.stringify([data.score, data.durationMs]));
    const receipt = await db.transaction(async (conn) => {
      // A player-level lock serializes simultaneous runs before any best row exists.
      await conn.execute('SELECT id FROM game_lb_players WHERE namespace=? AND id=? FOR UPDATE', [
        namespace,
        player.id,
      ]);
      const [[run]] = await conn.execute(
        'SELECT *, expires_at<UTC_TIMESTAMP(3) AS expired, TIMESTAMPDIFF(MICROSECOND,issued_at,UTC_TIMESTAMP(3))/1000 AS elapsed FROM game_lb_runs WHERE namespace=? AND id=? AND player_id=? FOR UPDATE',
        [namespace, runId, player.id],
      );
      const previous = previousSubmission(run, namespace, player.id, submissionHash);
      if (previous) return previous;
      const rules = await board(conn, run.board_id);
      if (!rules.open) fail(409, 'board_closed');
      assertRunRules(run, rules);
      if (
        data.score < Number(rules.min_score) ||
        data.score > Number(rules.max_score) ||
        data.durationMs < Number(rules.min_duration_ms) ||
        data.durationMs > Number(rules.max_duration_ms) ||
        data.durationMs > Number(run.elapsed) + 5000
      )
        fail(422, 'score_outside_rules');
      const rankValue = rules.direction === 'desc' ? -data.score : data.score;
      const [[best]] = await conn.execute(
        'SELECT rank_value FROM game_lb_best WHERE namespace=? AND board_id=? AND player_id=? FOR UPDATE',
        [namespace, run.board_id, player.id],
      );
      if (!best) {
        await conn.execute(
          'INSERT INTO game_lb_best (namespace,board_id,player_id,score,rank_value,achieved_at,run_id) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3),?)',
          [namespace, run.board_id, player.id, data.score, rankValue, run.id],
        );
      } else if (rankValue < Number(best.rank_value)) {
        await conn.execute(
          'UPDATE game_lb_best SET score=?,rank_value=?,achieved_at=UTC_TIMESTAMP(3),run_id=? WHERE namespace=? AND board_id=? AND player_id=?',
          [data.score, rankValue, run.id, namespace, run.board_id, player.id],
        );
      }
      await conn.execute(
        'UPDATE game_lb_runs SET score=?,duration_ms=?,submission_hash=?,submitted_at=UTC_TIMESTAMP(3) WHERE namespace=? AND id=?',
        [data.score, data.durationMs, submissionHash, namespace, run.id],
      );
      return { runId: run.id, score: data.score, accepted: true, trust: 'client_reported' };
    });
    return receipt;
  }
  return { identity, account, createGuest, list, beginRun, submitRun };
}
