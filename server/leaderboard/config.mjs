export function validateLeaderboardConfig(value) {
  if (!value || !['guest', 'account'].includes(value.identity) || Object.keys(value).some(key => !['identity', 'boards'].includes(key)) ||
    !Array.isArray(value.boards) || !value.boards.length || value.boards.length > 100) throw new Error('leaderboard_configuration_invalid');
  const ids = new Set();
  for (const board of value.boards) {
    if (!board || Object.keys(board).some(key => !['id', 'rulesVersion'].includes(key)) ||
      typeof board.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(board.id) || typeof board.rulesVersion !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(board.rulesVersion) || ids.has(board.id)) throw new Error('leaderboard_configuration_invalid');
    ids.add(board.id);
  }
  return value;
}
