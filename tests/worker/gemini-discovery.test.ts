import { describe, it, expect, mock, afterEach, spyOn } from 'bun:test';
import { DynamicModelRegistry } from '../../src/services/worker/gemini/DynamicModelRegistry.js';
import { RateLimitTracker } from '../../src/services/worker/gemini/RateLimitTracker.js';
import { classifyGeminiError } from '../../src/services/worker/GeminiProvider.js';
import { logger } from '../../src/utils/logger.js';

const registry = DynamicModelRegistry.getInstance();
const initial = registry.getCascade();
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  (registry as any).cascade = initial;
  (registry as any).lastDiscoveredAt = 0;
});

const model = (id: string, methods = ['generateContent']) => ({
  name: `models/${id}`, displayName: id, supportedGenerationMethods: methods,
  inputTokenLimit: 100000, outputTokenLimit: 8000,
});

describe('Gemini model discovery', () => {
  it('preserves a valid catalog for empty and embedding-only responses', async () => {
    global.fetch = mock(async () => new Response(JSON.stringify({ models: [] })));
    expect(await registry.discoverModels('fake-test-key', true)).toEqual(initial);
    global.fetch = mock(async () => new Response(JSON.stringify({ models: [model('embedding-001', ['embedContent'])] })));
    expect(await registry.discoverModels('fake-test-key', true)).toEqual(initial);
  });

  it('publishes both pages together and preserves the old catalog if page two fails', async () => {
    const urls: string[] = [];
    global.fetch = mock(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify(urls.length === 1
        ? { models: [model('gemini-test-flash')], nextPageToken: 'page 2' }
        : { models: [model('gemini-test-pro')] }));
    });
    const discovered = await registry.discoverModels('fake-test-key', true);
    expect(discovered.map(m => m.id)).toContain('gemini-test-pro');
    expect(new URL(urls[1]).searchParams.get('pageToken')).toBe('page 2');

    const prior = registry.getCascade();
    let page = 0;
    global.fetch = mock(async () => ++page === 1
      ? new Response(JSON.stringify({ models: [model('gemini-new-flash')], nextPageToken: 'second' }))
      : new Response('{}', { status: 500 }));
    expect(await registry.discoverModels('fake-test-key', true)).toBe(prior);
    expect(page).toBe(2);
  });

  it('stops a repeated page token without publishing partial results', async () => {
    global.fetch = mock(async () => new Response(JSON.stringify({ models: [model('gemini-test-flash')], nextPageToken: 'repeat' })));
    expect(await registry.discoverModels('fake-test-key', true)).toBe(initial);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('can surface an upstream refresh failure while preserving the catalog', async () => {
    global.fetch = mock(async () => new Response('{}', { status: 500 }));
    await expect(registry.discoverModels('fake-test-key', true, true)).rejects.toThrow('HTTP 500');
    expect(registry.getCascade()).toBe(initial);
  });

  it('does not select image or TTS output models or unsafe path IDs for text observations', async () => {
    global.fetch = mock(async () => new Response(JSON.stringify({ models: [
      model('gemini-3.1-flash-image'), model('gemini-3.8-flash-tts'), model('../unsafe'), model('gemini-test-flash'),
    ] })));
    const models = await registry.discoverModels('fake-test-key', true);
    expect(models.map(m => m.id)).toEqual(['gemini-test-flash']);
  });

  it('never exposes provider body markers in classified errors or tracker logs', () => {
    const marker = 'REVIEW_SECRET_MARKER';
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      for (const status of [403, 422, 503]) {
        const body = `model restricted or overloaded ${marker}`;
        const error = classifyGeminiError({ status, bodyText: body, cause: new Error('safe') });
        expect(error.message).not.toContain(marker);
        expect(JSON.stringify(error.cause)).not.toContain(marker);
        RateLimitTracker.getInstance().recordRequestFailure('gemini-pro-latest', status, body);
      }
      expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
    } finally {
      warn.mockRestore();
    }
  });
});
