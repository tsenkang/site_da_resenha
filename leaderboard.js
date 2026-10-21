// Optional Three.js online companion. Every network failure is a visible Result,
// so callers can always continue local gameplay without awaiting online success.
export function createLeaderboardClient({ identity, boardId, rulesVersion, auth, storage, fetch: request = globalThis.fetch, location = globalThis.location }) {
  if (!['guest', 'account'].includes(identity) || typeof boardId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(boardId) || typeof rulesVersion !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(rulesVersion)) throw new Error('leaderboard_configuration_invalid');
  if (identity === 'account' && !auth) throw new Error('canonical_manus_auth_required');
  const marker = location.pathname.indexOf('/__manus__/game-preview/');
  const prefix = marker < 0 ? '' : location.pathname.slice(0, marker);
  const base = prefix + '/api/leaderboards/v1';
  const localPreview = /^(127\.0\.0\.1|localhost)$/.test(location.hostname || '');
  const key = `manus-leaderboard:${prefix}:guest`;
  const runs = new WeakMap();
  let token = null, upgradeRequired = false, connecting = null;
  try { if (identity === 'guest') { storage ??= globalThis.localStorage; token = storage?.getItem(key) || null; } } catch { /* Storage may be unavailable in embedded previews. */ }
  function saveToken(value) {
    token = value;
    try { if (value) storage?.setItem(key, value); else storage?.removeItem(key); } catch { /* This session still works in memory. */ }
  }
  function fail(code) { throw new Error(code); }
  async function result(action) {
    try { return { ok: true, value: await action() }; }
    catch (error) {
      const code = error instanceof Error ? error.message : 'leaderboard_unavailable';
      if (code === 'client_upgrade_required') upgradeRequired = true;
      return { ok: false, error: code };
    }
  }
  async function rest(path, method = 'GET', body) {
    const response = await request(base + path, {
      method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}`, 'X-Guest-Token': token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) {
      if (response.status === 401) saveToken(null);
      fail(value.error || 'leaderboard_unavailable');
    }
    return value;
  }
  function canWrite() {
    if (upgradeRequired) fail('client_upgrade_required');
    if (identity === 'guest' && !token) fail('guest_session_required');
  }
  async function list(limit = 20) {
    return result(() => identity === 'account' ? auth.query('leaderboard.list', { boardId, limit }) : rest(`/boards/${encodeURIComponent(boardId)}?limit=${limit}`));
  }
  async function send(ticket, record) {
    const receipt = identity === 'account' ? await auth.mutate('leaderboard.submitRun', { runId: ticket.runId, ...record.payload }) : await rest(`/runs/${ticket.runId}`, 'PUT', record.payload);
    // A refresh failure cannot turn an accepted score into a failed submission.
    return { receipt, leaderboard: await list() };
  }
  return Object.freeze({
    list,
    ensureGuest(displayName) {
      if (!connecting) connecting = result(async () => {
        if (identity !== 'guest') fail('account_mode_has_no_guest');
        if (localPreview) fail('local_preview');
        if (!token) saveToken((await rest('/guests', 'POST', { displayName })).token);
        return undefined;
      }).finally(() => { connecting = null; });
      return connecting;
    },
    beginRun(releaseSha) {
      return result(async () => {
        canWrite();
        const input = { protocolVersion: 1, rulesVersion, ...(releaseSha ? { releaseSha } : {}) };
        const issued = identity === 'account' ? await auth.mutate('leaderboard.beginRun', { boardId, ...input }) : await rest(`/boards/${encodeURIComponent(boardId)}/runs`, 'POST', input);
        const ticket = Object.freeze({ runId: issued.runId });
        runs.set(ticket, { payload: null });
        return ticket;
      });
    },
    submitRun(ticket, score, durationMs) {
      return result(async () => {
        canWrite();
        const record = runs.get(ticket);
        if (!record) fail('run_not_owned');
        if (!Number.isSafeInteger(score) || Math.abs(score) > 1e9 || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 1800000) fail('invalid_score');
        if (record.payload && (record.payload.score !== score || record.payload.durationMs !== durationMs)) fail('submission_conflict');
        record.payload = Object.freeze({ score, durationMs });
        return send(ticket, record);
      });
    },
    retryRun(ticket) {
      return result(async () => {
        canWrite();
        const record = runs.get(ticket);
        if (!record?.payload) fail('submission_not_started');
        return send(ticket, record);
      });
    },
  });
}
