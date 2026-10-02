import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { paths } from '../../../../src/shared/paths.js';
import { RateLimitTracker } from '../../../../src/services/worker/gemini/RateLimitTracker.js';

function handlers() {
  let get!: (req: any, res: any) => void;
  let post!: (req: any, res: any) => void;
  new SettingsRoutes({} as never).setupRoutes({
    get: (path: string, handler: typeof get) => { if (path === '/api/settings') get = handler; },
    post: (path: string, handler: typeof post) => { if (path === '/api/settings') post = handler; },
  } as never);
  function call(handler: typeof get, body: object = {}, origin?: string) {
    const json = mock((value: unknown) => value);
    const status = mock((_code: number) => ({ json }));
    handler({ body, headers: { host: 'localhost:37778', ...(origin ? { origin } : {}) } }, { json, status, headersSent: false });
    return { value: json.mock.calls[0]?.[0] as any, code: status.mock.calls[0]?.[0] ?? 200 };
  }
  return { get: () => call(get), post: (body: object, origin?: string) => call(post, body, origin) };
}

describe('Gemini settings round trip', () => {
  const settingsPath = paths.settings();
  let prior: string | undefined;
  beforeEach(() => {
    prior = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : undefined;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_GEMINI_API_KEY: 'fake-test-key' }));
  });
  afterEach(() => {
    if (prior === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, prior);
  });

  it('accepts auto and a catalog model and persists fallback false', () => {
    const h = handlers();
    expect(h.post({ CLAUDE_MEM_GEMINI_MODEL: 'auto', CLAUDE_MEM_GEMINI_AUTO_FALLBACK: 'false' }).code).toBe(200);
    expect(h.get().value.CLAUDE_MEM_GEMINI_MODEL).toBe('auto');
    expect(h.get().value.CLAUDE_MEM_GEMINI_AUTO_FALLBACK).toBe('false');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).CLAUDE_MEM_GEMINI_AUTO_FALLBACK).toBe('false');
    expect(h.post({ CLAUDE_MEM_GEMINI_MODEL: 'gemini-3.1-pro-preview' }).code).toBe(200);
    expect(h.get().value.CLAUDE_MEM_GEMINI_MODEL).toBe('gemini-3.1-pro-preview');
  });

  it('accepts a well-formed model ID missing from the in-RAM catalog (discovered before restart)', () => {
    expect(handlers().post({ CLAUDE_MEM_GEMINI_MODEL: 'gemini-discovered-9' }).code).toBe(200);
  });

  it('rejects malformed models and invalid fallback values', () => {
    const h = handlers();
    expect(h.post({ CLAUDE_MEM_GEMINI_MODEL: 'bad model!' }).code).toBe(400);
    expect(h.post({ CLAUDE_MEM_GEMINI_AUTO_FALLBACK: 'maybe' }).code).toBe(400);
  });

  it('keeps a masked secret when saving the controls', () => {
    const h = handlers();
    const masked = h.get().value.CLAUDE_MEM_GEMINI_API_KEY;
    expect(h.post({ CLAUDE_MEM_GEMINI_API_KEY: masked, CLAUDE_MEM_GEMINI_MODEL: 'auto' }).code).toBe(200);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).CLAUDE_MEM_GEMINI_API_KEY).toBe('fake-test-key');
  });

  it('rejects browser writes from a different loopback port', () => {
    const h = handlers();
    expect(h.post({ CLAUDE_MEM_GEMINI_MODEL: 'auto' }, 'http://localhost:9999').code).toBe(403);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).CLAUDE_MEM_GEMINI_MODEL).toBeUndefined();
  });

  it('retains configured model and fallback in SSE status after settings changes', () => {
    const h = handlers();
    const tracker = RateLimitTracker.getInstance();
    const priorHandler = (tracker as any).onStatusChange;
    const updates: Array<{ configuredModel?: string; autoFallback: boolean }> = [];
    tracker.setStatusChangeHandler(status => updates.push(status));
    try {
      expect(h.post({ CLAUDE_MEM_GEMINI_MODEL: 'gemini-3.1-pro-preview', CLAUDE_MEM_GEMINI_AUTO_FALLBACK: 'false' }).code).toBe(200);
      tracker.updateQueueState({ depth: 1 });
      expect(updates.at(-1)?.configuredModel).toBe('gemini-3.1-pro-preview');
      expect(updates.at(-1)?.autoFallback).toBe(false);
      expect(tracker.getStatus().configuredModel).toBe('gemini-3.1-pro-preview');
    } finally {
      (tracker as any).onStatusChange = priorHandler;
      tracker.updateQueueState({ depth: 0 });
    }
  });
});
