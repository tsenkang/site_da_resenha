import { fail, idPattern, uuidPattern } from './service.mjs';
export const send = (res, status, data) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
};
async function body(req, keys) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'json_required');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 2048) fail(413, 'body_too_large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json'); }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some((key) => !keys.includes(key))) fail(400, 'invalid_fields');
  return value;
}

export const prefix = '/api/leaderboards/v1';
// Preview ingress in older sandbox runtimes strips Authorization, so guest clients also send X-Guest-Token.
const guestAuthorization = (req) => req.headers['x-guest-token'] ? `Bearer ${req.headers['x-guest-token']}` : req.headers.authorization;
export function createLeaderboardRest(service, { ready, check, readonly = false, guestWrites = true }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://game-api');
    if (!url.pathname.startsWith(`${prefix}/`)) fail(404, 'not_found');
    if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'cross_origin_request');
    if (url.pathname === `${prefix}/health` && req.method === 'GET') return send(res, 200, await ready());
    if (!guestWrites && req.method !== 'GET') fail(403, 'account_session_required');
    await check();
    if (readonly && req.method !== 'GET') fail(403, 'leaderboard_read_only');
    if (req.method === 'POST' && url.pathname === `${prefix}/guests`) return send(res, 201, await service.createGuest(await body(req, ['displayName'])));
    const route = url.pathname.slice(prefix.length).split('/').filter(Boolean);
    if (route[0] === 'boards' && idPattern.test(route[1] || '')) {
      if (req.method === 'GET' && route.length === 2) return send(res, 200, await service.list(route[1], Number(url.searchParams.get('limit') || 20), await service.identity(guestAuthorization(req), false)));
      if (req.method === 'POST' && route.length === 3 && route[2] === 'runs') {
        const player = await service.identity(guestAuthorization(req));
        return send(res, 201, await service.beginRun(route[1], player, await body(req, ['releaseSha', 'protocolVersion', 'rulesVersion'])));
      }
    }
    if (req.method === 'PUT' && route.length === 2 && route[0] === 'runs' && uuidPattern.test(route[1])) {
      const player = await service.identity(guestAuthorization(req));
      return send(res, 200, await service.submitRun(route[1], player, await body(req, ['score', 'durationMs'])));
    }
    fail(404, 'not_found');
  };
}
