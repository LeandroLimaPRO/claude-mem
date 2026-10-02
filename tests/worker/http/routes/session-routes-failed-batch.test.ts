import { describe, it, expect, mock } from 'bun:test';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import type { ActiveSession } from '../../../../src/services/worker-types.js';
import { ClassifiedProviderError } from '../../../../src/services/worker/provider-errors.js';
import { getQuotaCooldown, resetQuotaCooldownsForTesting } from '../../../../src/shared/quota-cooldown.js';

function harness(fail: boolean, failure: Error = new Error('simulated provider failure')) {
  let pending = 0;
  let failuresRemaining = fail ? 1 : 0;
  const session = {
    sessionDbId: 4147,
    abortController: new AbortController(),
    abortReason: null,
    generatorPromise: null,
    currentProvider: null,
    claimedMessageIds: [1],
    conversationHistory: [],
    platformSource: 'claude',
    lastGeneratorActivity: Date.now(),
  } as unknown as ActiveSession;
  const resetProcessingToPending = mock(async () => {
    pending = 1;
    session.claimedMessageIds = [];
    return 1;
  });
  const finalizeSession = mock(async () => {});
  const removeSessionImmediate = mock(() => {});
  const sessionManager = {
    getSession: () => session,
    getMessageBuffer: () => ({ getPendingCount: () => pending }),
    resetProcessingToPending,
    removeSessionImmediate,
  };
  const startSession = mock(async () => {
    if (failuresRemaining-- > 0) throw failure;
    pending = 0;
  });
  const routes = new SessionRoutes(
    sessionManager as never, {} as never, { startSession } as never,
    { startSession } as never, {} as never, {} as never, {} as never,
    { finalizeSession } as never,
  );
  return { routes, session, startSession, resetProcessingToPending, finalizeSession, removeSessionImmediate, pending: () => pending };
}

describe('SessionRoutes failed batch lifecycle', () => {
  it('keeps claimed work after a provider rejection until the next start', async () => {
    const h = harness(true);
    await (h.routes as any).startGeneratorWithProvider(h.session, 'claude', 'test', null);
    await h.session.generatorPromise;
    expect(h.pending()).toBe(1);
    expect(h.session.claimedMessageIds).toEqual([]);
    expect(h.finalizeSession).not.toHaveBeenCalled();
    expect(h.removeSessionImmediate).not.toHaveBeenCalled();
    expect(h.startSession).toHaveBeenCalledTimes(1);

    await (h.routes as any).startGeneratorWithProvider(h.session, 'claude', 'next-ingest', null);
    await h.session.generatorPromise;
    expect(h.pending()).toBe(0);
    expect(h.startSession).toHaveBeenCalledTimes(2);
  });

  it('finalizes instead of re-sending a batch the provider classified as unrecoverable', async () => {
    const h = harness(true, new ClassifiedProviderError('HTTP 400 bad request', { kind: 'unrecoverable', cause: null }));
    await (h.routes as any).startGeneratorWithProvider(h.session, 'gemini', 'test', null);
    await h.session.generatorPromise;
    expect(h.finalizeSession).toHaveBeenCalledWith(4147);
  });

  it('still finalizes a successful idle generator', async () => {
    const h = harness(false);
    await (h.routes as any).startGeneratorWithProvider(h.session, 'claude', 'test', null);
    await h.session.generatorPromise;
    expect(h.finalizeSession).toHaveBeenCalledWith(4147);
    expect(h.removeSessionImmediate).toHaveBeenCalledWith(4147);
  });

  it('keeps minute-limited work without arming the 30-minute allowance breaker', async () => {
    resetQuotaCooldownsForTesting();
    try {
      const error = new ClassifiedProviderError('HTTP 429', { kind: 'rate_limit', cause: null });
      const h = harness(true, error);
      await (h.routes as any).startGeneratorWithProvider(h.session, 'gemini', 'test', null);
      await h.session.generatorPromise;
      expect(h.pending()).toBe(1);
      expect(getQuotaCooldown('gemini')).toBeNull();
    } finally {
      resetQuotaCooldownsForTesting();
    }
  });
});
