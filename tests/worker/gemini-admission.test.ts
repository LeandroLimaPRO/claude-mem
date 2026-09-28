import { describe, it, expect, mock, afterEach, spyOn } from 'bun:test';
import * as timers from 'node:timers/promises';
import { GeminiProvider } from '../../src/services/worker/GeminiProvider.js';
import { RateLimitTracker } from '../../src/services/worker/gemini/RateLimitTracker.js';

const tracker = RateLimitTracker.getInstance();
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  tracker.resetAllCounters();
  tracker.setAutoFallback(true);
});

function query(model: string, signal?: AbortSignal, input = 'observe', rateLimitingEnabled = true, autoFallback = false) {
  const agent = new GeminiProvider({} as never, {} as never);
  return (agent as any).executeWithDynamicCascade(
    [{ role: 'user', content: input }],
    { apiKey: 'fake-test-key', model, rateLimitingEnabled, autoFallback },
    signal,
  );
}

describe('Gemini admission', () => {
  it('admits only two concurrent requests to a model with 2 RPM', async () => {
    tracker.resetAllCounters();
    tracker.setAutoFallback(false);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    global.fetch = mock(async () => {
      await gate;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    });
    const thirdAbort = new AbortController();
    const pending = [
      query('gemini-pro-latest'),
      query('gemini-pro-latest'),
      query('gemini-pro-latest', thirdAbort.signal).catch(e => e),
    ];
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(tracker.getRpmUsed('gemini-pro-latest')).toBe(2);
    } finally {
      thirdAbort.abort();
      release();
      await Promise.all(pending);
    }
  });

  it('never silently replaces an unknown fixed model', () => {
    tracker.setAutoFallback(false);
    expect(() => tracker.selectBestAvailableModel('unknown-model', 100)).toThrow();
  });

  it('refuses a request larger than every candidate TPM instead of waiting forever', () => {
    tracker.setAutoFallback(true);
    expect(() => tracker.selectBestAvailableModel('auto', 1_000_000_000)).toThrow();
  });

  it('rechecks quota after each 60-second part of a 120-second wait', async () => {
    tracker.resetAllCounters();
    tracker.setAutoFallback(false);
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    tracker.setCooldown('gemini-pro-latest', 120_000, 'test');
    const waits: Array<{ ms: number; resume: () => void }> = [];
    const sleep = spyOn(timers, 'setTimeout').mockImplementation((ms => new Promise<void>(resolve => {
      waits.push({ ms: Number(ms), resume: () => { now += Number(ms); resolve(); } });
    })) as any);
    global.fetch = mock(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })));
    try {
      const pending = query('gemini-pro-latest');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(waits[0]?.ms).toBe(60_000);
      expect(global.fetch).toHaveBeenCalledTimes(0);
      waits[0].resume();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(waits[1]?.ms).toBeGreaterThan(59_000);
      expect(global.fetch).toHaveBeenCalledTimes(0);
      waits[1].resume();
      await pending;
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      sleep.mockRestore();
      clock.mockRestore();
    }
  });

  it('resolves auto with rate limiting disabled and rejects pre-aborted work', async () => {
    global.fetch = mock(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })));
    await query('auto', undefined, 'observe', false);
    expect(String((global.fetch as any).mock.calls[0][0])).not.toContain('/models/auto:');
    const controller = new AbortController();
    controller.abort();
    await expect(query('gemini-pro-latest', controller.signal)).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts a quota wait without sending or leaving the queue paused', async () => {
    tracker.setAutoFallback(false);
    tracker.setCooldown('gemini-pro-latest', 60_000, 'test');
    global.fetch = mock(async () => new Response('{}'));
    const controller = new AbortController();
    const pending = query('gemini-pro-latest', controller.signal);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(tracker.getStatus().queue.isWaitingForQuota).toBe(true);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(0);
    expect(tracker.getStatus().queue.isWaitingForQuota).toBe(false);
  });

  it('keeps RPM charged when an in-flight fetch is aborted', async () => {
    tracker.resetAllCounters();
    tracker.setAutoFallback(false);
    global.fetch = mock((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted in flight')), { once: true });
    }));
    const controller = new AbortController();
    const pending = query('gemini-pro-latest', controller.signal);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(tracker.getRpmUsed('gemini-pro-latest')).toBe(1);
    expect(tracker.getRpdUsed('gemini-pro-latest')).toBe(1);
  });

  for (const status of [429, 404, 503]) {
    it(`does not retry model ${status} before cascading`, async () => {
      tracker.resetAllCounters();
      tracker.setAutoFallback(true);
      const urls: string[] = [];
      global.fetch = mock(async (url: string | URL | Request) => {
        urls.push(String(url));
        return urls.length === 1
          ? new Response(status === 429 ? 'rate limit' : status === 503 ? 'model is overloaded' : 'not found', { status })
          : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
      });
      await query('gemini-pro-latest', undefined, 'observe', true, true);
      expect(urls.filter(u => u.includes('/models/gemini-pro-latest:'))).toHaveLength(1);
      expect(urls).toHaveLength(2);
    });
  }

  it('charges each transient network retry as a separate request', async () => {
    tracker.resetAllCounters();
    tracker.setAutoFallback(false);
    let attempts = 0;
    global.fetch = mock(async () => {
      if (++attempts < 3) throw new Error('temporary network failure');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    });
    await query('gemini-flash-latest');
    expect(attempts).toBe(3);
    expect(tracker.getRpmUsed('gemini-flash-latest')).toBe(3);
  });

  it('uses input tokens for TPM while preserving total usage', async () => {
    tracker.resetAllCounters();
    tracker.setAutoFallback(false);
    global.fetch = mock(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 900, totalTokenCount: 1000 },
    })));
    const result = await query('gemini-pro-latest');
    expect(tracker.getTpmUsed('gemini-pro-latest')).toBe(100);
    expect(result.tokensUsed).toBe(1000);
  });
});
