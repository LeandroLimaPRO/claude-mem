import { expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

for (const nested of [false, true]) {
  it(`persists model and fallback for the provider (${nested ? 'nested' : 'flat'} settings)`, () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gemini-settings-'));
    const settingsPath = join(dataDir, 'settings.json');
    const initial = { CLAUDE_MEM_GEMINI_MODEL: 'auto', CLAUDE_MEM_GEMINI_AUTO_FALLBACK: 'true', custom: 'keep' };
    writeFileSync(settingsPath, JSON.stringify(nested ? { env: initial, theme: 'dark' } : initial));
    // A separate process keeps other suites' mock.module replacements out of this integration check.
    const child = Bun.spawnSync([process.execPath, '-e', `
      import { GeminiRoutes } from './src/services/worker/http/routes/GeminiRoutes.ts';
      import { GeminiProvider } from './src/services/worker/GeminiProvider.ts';
      const route = new GeminiRoutes();
      const response = { status: () => response, json: () => {} };
      route.handleSelectModel({ body: { model: 'gemini-flash-latest' } }, response);
      route.handleSelectModel({ body: { autoFallback: false } }, response);
      const { model, autoFallback } = new GeminiProvider({}, {}).getConfig();
      console.log(JSON.stringify({ model, autoFallback }));
    `], {
      cwd: resolve(import.meta.dir, '../../../..'),
      env: {
        ...process.env, NODE_ENV: 'test', CLAUDE_MEM_DATA_DIR: dataDir,
        CLAUDE_MEM_GEMINI_MODEL: undefined, CLAUDE_MEM_GEMINI_AUTO_FALLBACK: undefined,
      },
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({ model: 'gemini-flash-latest', autoFallback: false });
    const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect((nested ? saved.env : saved).custom).toBe('keep');
    if (nested) expect(saved.theme).toBe('dark');
  });
}
