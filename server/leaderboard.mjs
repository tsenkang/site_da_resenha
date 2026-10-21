import { readFileSync } from 'node:fs';
import { createLeaderboardRuntime } from './leaderboard/runtime.mjs';
export const leaderboard = createLeaderboardRuntime(JSON.parse(readFileSync(new URL('./leaderboard.config.json', import.meta.url), 'utf8')));
