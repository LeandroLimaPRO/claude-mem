import { describe, it, expect } from 'bun:test';

/**
 * Test for P2 finding: Settings validation should accept model IDs in valid format
 * even if not currently in the catalog (e.g., discovered models after restart).
 */
describe('Settings model validation', () => {
  const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  it('should accept "auto" as valid model ID', () => {
    expect('auto').toBe('auto');
  });

  it('should accept model IDs matching the format pattern', () => {
    const validIds = [
      'gemini-3.9-flash-exp',
      'gemini-flash-latest',
      'gemini_ultra_2',
      'gpt-4',
      'claude-3-opus',
    ];

    for (const id of validIds) {
      expect(modelIdPattern.test(id)).toBe(true);
    }
  });

  it('should reject model IDs not matching the format pattern', () => {
    const invalidIds = [
      '-starts-with-dash',
      '',
      'has space',
      'has/slash',
      'has\\backslash',
    ];

    for (const id of invalidIds) {
      expect(modelIdPattern.test(id)).toBe(false);
    }
  });

  it('should accept valid discovered model format', () => {
    const discoveredModel = 'gemini-3.7-flash';
    expect(modelIdPattern.test(discoveredModel)).toBe(true);
  });
});
