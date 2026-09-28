import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { GeminiProvider, type GeminiConfig } from '../src/services/worker/GeminiProvider.js';
import { RateLimitTracker } from '../src/services/worker/gemini/RateLimitTracker.js';
import { DynamicModelRegistry } from '../src/services/worker/gemini/DynamicModelRegistry.js';
import * as timers from 'node:timers/promises';

describe('Gemini dynamic cascade regressions', () => {
  const tracker = RateLimitTracker.getInstance();
  const registry = DynamicModelRegistry.getInstance();
  const provider = new GeminiProvider({} as any, {} as any);
  const history = [{ role: 'user', content: 'test' }];
  const config: GeminiConfig = {
    apiKey: 'test-key', model: 'auto', rateLimitingEnabled: true, autoFallback: true,
  };
  let fetchSpy: ReturnType<typeof spyOn>;
  let models: string[];

  beforeEach(() => {
    tracker.resetAllCounters();
    tracker.setAutoFallback(true);
    models = [];
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const model = String(url).split('/models/')[1].split(':')[0];
      models.push(model);
      return model.includes('pro')
        ? new Response('not found', { status: 404 })
        : Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    tracker.resetAllCounters();
    tracker.setAutoFallback(true);
  });

  it('reaches Flash after all four Pro candidates fail', async () => {
    const result = await (provider as any).executeWithDynamicCascade(history, config);
    expect(result.servedModel).toBe('gemini-flash-latest');
    expect(new Set(models).size).toBe(5);
  });

  it('stops after exhausting the catalog without revisiting failed models', async () => {
    fetchSpy.mockImplementation(async (url) => {
      models.push(String(url).split('/models/')[1].split(':')[0]);
      return new Response('not found', { status: 404 });
    });
    await expect((provider as any).executeWithDynamicCascade(history, config)).rejects.toThrow();
    expect(models).toEqual(registry.getCascade().map(model => model.id));
  });

  it('forwards cancellation to the in-flight fetch', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    fetchSpy.mockImplementation(async (_url, options) => {
      requestSignal = options?.signal as AbortSignal;
      controller.abort();
      throw new Error('cancelled');
    });
    await expect((provider as any).executeWithDynamicCascade(history, config, controller.signal)).rejects.toThrow();
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  for (const status of [404, 429]) {
    it(`leaves the inner retry immediately when ${status} selects a fallback`, async () => {
      fetchSpy.mockImplementation(async (url) => {
        const model = String(url).split('/models/')[1].split(':')[0];
        models.push(model);
        return model === 'gemini-flash-latest'
          ? new Response('unavailable', { status })
          : Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
      });
      const result = await (provider as any).executeWithDynamicCascade(history, { ...config, model: 'gemini-flash-latest' });
      expect(result.content).toBe('ok');
      expect(models).toEqual(['gemini-flash-latest', 'gemini-pro-latest']);
    });
  }

  it('sends no request when the field deadline has already expired', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect((provider as any).executeWithDynamicCascade(history, {
      ...config, model: 'gemini-flash-latest', rateLimitingEnabled: false, autoFallback: false,
    }, controller.signal)).rejects.toThrow();
    expect(models).toEqual([]);
  });

  it('does not retry a field compression request with a deadline', async () => {
    fetchSpy.mockImplementation(async () => {
      models.push('failed');
      return new Response('internal error', { status: 500 });
    });
    await expect((provider as any).executeWithDynamicCascade(history, {
      ...config, model: 'gemini-flash-latest', rateLimitingEnabled: false, autoFallback: false,
    }, new AbortController().signal)).rejects.toThrow();
    expect(models.length).toBe(1);
  });

  it('aborts a quota wait without sending a request and clears waiting state', async () => {
    tracker.setAutoFallback(false);
    tracker.setCooldown('gemini-flash-latest', 60_000, 'test');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      await expect((provider as any).executeWithDynamicCascade(history, {
        ...config, model: 'gemini-flash-latest', autoFallback: false,
      }, controller.signal)).rejects.toThrow();
      expect(models).toEqual([]);
      expect(tracker.getStatus().queue.isWaitingForQuota).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  }, 300);

  it('resolves auto with both rate limiting and fallback disabled', async () => {
    fetchSpy.mockImplementation(async (url) => {
      models.push(String(url).split('/models/')[1].split(':')[0]);
      return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    });
    const result = await (provider as any).executeWithDynamicCascade(history, {
      ...config, rateLimitingEnabled: false, autoFallback: false,
    });
    expect(models).toEqual(['gemini-pro-latest']);
    expect(result.servedModel).toBe('gemini-pro-latest');
  });

  it('rechecks quota after each capped wait before sending a request', async () => {
    const model = 'gemini-flash-latest';
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const waits: number[] = [];
    const sleep = spyOn(timers, 'setTimeout').mockImplementation((async (ms: number) => {
      waits.push(ms);
      now += ms;
    }) as any);
    tracker.setAutoFallback(false);
    tracker.setCooldown(model, 125_000, 'test');
    fetchSpy.mockImplementation(async () => {
      expect(tracker.canExecute(model, 100).allowed).toBe(true);
      return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    });
    try {
      const result = await (provider as any).executeWithDynamicCascade(history, { ...config, model, autoFallback: false });
      expect(result.content).toBe('ok');
      expect(waits).toEqual([60_000, 60_000, 5_000]);
    } finally {
      sleep.mockRestore();
      clock.mockRestore();
    }
  });
});
