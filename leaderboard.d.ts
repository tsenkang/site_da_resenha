export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export type RunTicket = Readonly<{ runId: string }>;
export type Leaderboard = {
  namespace: string; boardId: string; rulesVersion: string; trust: 'client_reported';
  entries: { playerId: string; displayName: string; score: number; rank: number; achievedAt: string }[];
  myRank: { rank: number; score: number } | null;
};
export type Submission = {
  receipt: { runId: string; score: number; accepted: true; trust: 'client_reported' };
  leaderboard: Result<Leaderboard>;
};
export type LeaderboardClient = {
  list(limit?: number): Promise<Result<Leaderboard>>;
  ensureGuest(displayName: string): Promise<Result<void>>;
  beginRun(releaseSha?: string): Promise<Result<RunTicket>>;
  submitRun(ticket: RunTicket, score: number, durationMs: number): Promise<Result<Submission>>;
  retryRun(ticket: RunTicket): Promise<Result<Submission>>;
};
export function createLeaderboardClient(options: {
  identity: 'account' | 'guest'; boardId: string; rulesVersion: string;
  auth?: { query(procedure: string, input?: unknown): Promise<unknown>; mutate(procedure: string, input?: unknown): Promise<unknown> };
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  fetch?: typeof fetch;
  location?: Pick<Location, 'pathname'>;
}): LeaderboardClient;
