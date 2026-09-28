import { describe, it, expect, mock } from 'bun:test';
import { GeminiRoutes } from '../../../../src/services/worker/http/routes/GeminiRoutes.js';
import { DynamicModelRegistry } from '../../../../src/services/worker/gemini/DynamicModelRegistry.js';
import { RateLimitTracker } from '../../../../src/services/worker/gemini/RateLimitTracker.js';

function routes() {
  const posts = new Map<string, (req: any, res: any) => void>();
  new GeminiRoutes().setupRoutes({
    get: () => {},
    post: (path: string, handler: (req: any, res: any) => void) => posts.set(path, handler),
  } as never);
  return (path: string, body: object = {}, origin?: string) => {
    const json = mock((value: unknown) => value);
    const status = mock((_code: number) => ({ json }));
    posts.get(path)!({ body, headers: { host: 'localhost:37778', ...(origin ? { origin } : {}) } }, { json, status, headersSent: false });
    return { code: status.mock.calls[0]?.[0] ?? 200, value: json.mock.calls[0]?.[0] };
  };
}

describe('Gemini control routes', () => {
  it('returns a failure when upstream refresh fails and leaves the catalog intact', async () => {
    const registry = DynamicModelRegistry.getInstance();
    const priorCascade = registry.getCascade();
    const original = registry.discoverModels;
    const discover = mock(async () => { throw new Error('upstream failure'); });
    registry.discoverModels = discover as typeof original;
    try {
      let refresh!: (req: any, res: any) => void;
      new GeminiRoutes().setupRoutes({
        get: () => {},
        post: (path: string, handler: typeof refresh) => { if (path === '/api/gemini/refresh') refresh = handler; },
      } as never);
      const result = await new Promise<{ code: number; value: any }>(resolve => {
        let code = 200;
        const json = (value: unknown) => resolve({ code, value });
        const status = (next: number) => { code = next; return { json }; };
        refresh({ body: {}, path: '/api/gemini/refresh', headers: { host: 'localhost:37778' } }, { json, status, headersSent: false });
      });
      expect(result.code).toBe(502);
      expect(result.value.error).toBe('Gemini model discovery failed; catalog retained');
      expect(discover.mock.calls[0]?.[2]).toBe(true);
      expect(registry.getCascade()).toBe(priorCascade);
    } finally {
      registry.discoverModels = original;
    }
  });

  it('keeps the quota pause until the last concurrent waiter finishes', () => {
    const tracker = RateLimitTracker.getInstance();
    tracker.beginQuotaWait(120_000);
    tracker.beginQuotaWait(60_000);
    expect(tracker.endQuotaWait()).toBe(false);
    expect(tracker.getStatus().queue.isWaitingForQuota).toBe(true);
    expect(tracker.endQuotaWait()).toBe(true);
    expect(tracker.getStatus().queue.isWaitingForQuota).toBe(false);
  });

  it('rejects cross-port browser writes before refresh or state changes', () => {
    const call = routes();
    const tracker = RateLimitTracker.getInstance();
    const tier = tracker.getTier();
    const discover = mock(async () => []);
    const registry = DynamicModelRegistry.getInstance();
    const oldDiscover = registry.discoverModels;
    registry.discoverModels = discover as typeof oldDiscover;
    try {
      expect(call('/api/gemini/refresh', {}, 'http://localhost:9999').code).toBe(403);
      expect(call('/api/gemini/tier', { tier: tier === 'free' ? 'payg' : 'free' }, 'http://localhost:9999').code).toBe(403);
      expect(call('/api/gemini/calibrate-rpd', { model: 'gemini-3.7-flash', count: 10 }, 'http://localhost:9999').code).toBe(403);
      expect(discover).not.toHaveBeenCalled();
      expect(tracker.getTier()).toBe(tier);
    } finally {
      registry.discoverModels = oldDiscover;
    }
  });

  it('rejects fractional, infinite and unknown model calibration without mutation', () => {
    const call = routes();
    for (const count of [1.5, Infinity, NaN, -1]) {
      expect(call('/api/gemini/calibrate-rpd', { model: 'gemini-3.7-flash', count }).code).toBe(400);
    }
    expect(call('/api/gemini/calibrate-rpd', { model: 'unknown-model', count: 1 }).code).toBe(400);
  });
});
