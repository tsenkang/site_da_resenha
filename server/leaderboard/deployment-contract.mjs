const fail = code => { throw Object.assign(new Error(code), { status: 503, code }); };
export const PROTOCOL_VERSION = 1;
export const SCHEMA_VERSION = 2;

export function databaseName(value) {
  let url;
  try { url = new URL(value); } catch { fail('database_configuration_invalid'); }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== 'mysql:' || !url.username || !/^[a-zA-Z0-9_-]+$/.test(name)) fail('database_configuration_invalid');
  return name;
}

export async function assertDatabaseEnvironment(db, namespace) {
  const [[environment]] = await db.execute('SELECT namespace,schema_version FROM game_lb_environment WHERE id=1');
  if (environment?.namespace !== namespace || Number(environment.schema_version) !== SCHEMA_VERSION) fail('database_environment_mismatch');
}

export async function assertDatabaseReady(db, namespace, contract) {
  await assertDatabaseEnvironment(db, namespace);
  // Probe every column consumed by this API, including writes. A matching version
  // marker alone cannot prove that a partially applied migration is usable.
  // LIMIT 0 validates names without reading player data or changing the schema.
  await db.execute('SELECT namespace,id,player_id,board_id,issued_at,expires_at,release_sha,score,duration_ms,submission_hash,submitted_at,rules_version,protocol_version FROM game_lb_runs LIMIT 0');
  await db.execute('SELECT namespace,id,rules_version,direction,min_score,max_score,min_duration_ms,max_duration_ms,`open` FROM game_lb_boards LIMIT 0');
  await db.execute('SELECT namespace,id,display_name,token_hash,expires_at FROM game_lb_players LIMIT 0');
  await db.execute('SELECT namespace,board_id,player_id,score,rank_value,achieved_at,run_id FROM game_lb_best LIMIT 0');
  await db.execute('SELECT namespace,bucket_hash,window_start,request_count FROM game_lb_rate_limits LIMIT 0');
  if (contract) {
    if (contract.api.protocolVersion !== PROTOCOL_VERSION || contract.database.schemaVersion !== SCHEMA_VERSION) fail('backend_contract_incompatible');
    for (const board of contract.boards) {
      const [[actual]] = await db.execute('SELECT rules_version FROM game_lb_boards WHERE namespace=? AND id=?', [namespace, board.id]);
      if (actual?.rules_version !== board.rulesVersion) fail('backend_board_incompatible');
    }
  }
}

export function assertClientRules(input, rules) {
  if (input.protocolVersion !== PROTOCOL_VERSION || input.rulesVersion !== rules.rules_version) {
    throw Object.assign(new Error('client_upgrade_required'), { status: 426, code: 'client_upgrade_required' });
  }
}
export function assertRunRules(run, rules) {
  if (run.protocol_version !== PROTOCOL_VERSION || run.rules_version !== rules.rules_version) {
    throw Object.assign(new Error('run_rules_changed'), { status: 409, code: 'run_rules_changed' });
  }
}


export function previousSubmission(run, namespace, playerId, submissionHash) {
  const reject = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
  if (!run || run.namespace !== namespace || run.player_id !== playerId) reject(404, 'run_not_found');
  if (run.submission_hash) {
    if (run.submission_hash !== submissionHash) reject(409, 'submission_conflict');
    return { runId: run.id, score: Number(run.score), accepted: true, trust: 'client_reported' };
  }
  if (run.expired) reject(410, 'run_expired');
  return null;
}
