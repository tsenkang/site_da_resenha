import { TRPCError } from '@trpc/server';
import { z } from 'zod';

// Use the host's tRPC instance and protectedProcedure, hence canonical ctx.user.
export function createLeaderboardRouter({ router, publicProcedure, protectedProcedure }, runtime) {
  if (runtime.config.identity !== 'account') throw new Error('account_leaderboard_required');
  const boardId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
  async function call(ctx, write, action) {
    try { return await runtime.run(ctx, write, action); }
    catch (error) {
      const codes = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 410: 'NOT_FOUND', 422: 'UNPROCESSABLE_CONTENT', 426: 'PRECONDITION_FAILED', 429: 'TOO_MANY_REQUESTS', 503: 'SERVICE_UNAVAILABLE', 504: 'TIMEOUT' };
      throw new TRPCError({ code: codes[error.status] || 'INTERNAL_SERVER_ERROR', message: error.status && error.code ? error.code : 'leaderboard_unavailable' });
    }
  }
  return router({
    // Ranking is public, as in the guest REST API; personal rank requires a session.
    list: publicProcedure.input(z.object({ boardId, limit: z.number().int().min(1).max(100).default(20) }).strict()).query(({ ctx, input }) =>
      call(ctx, false, async service => service.list(input.boardId, input.limit, ctx.user ? await service.account(ctx.user, false) : null))),
    beginRun: protectedProcedure.input(z.object({ boardId, protocolVersion: z.number().int(), rulesVersion: z.string().min(1).max(32), releaseSha: z.string().regex(/^[a-f0-9]{7,64}$/).optional() }).strict()).mutation(({ ctx, input }) =>
      call(ctx, true, async service => service.beginRun(input.boardId, await service.account(ctx.user), input))),
    submitRun: protectedProcedure.input(z.object({ runId: z.string().uuid(), score: z.number().int().min(-1e9).max(1e9), durationMs: z.number().int().min(0).max(1800000) }).strict()).mutation(({ ctx, input }) =>
      call(ctx, true, async service => service.submitRun(input.runId, await service.account(ctx.user), input))),
  });
}
