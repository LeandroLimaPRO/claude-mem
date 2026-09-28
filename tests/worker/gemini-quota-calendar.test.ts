import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { writeFileSync, readFileSync } from 'fs';
import { RateLimitTracker, quotaDay, nextDailyResetAtMs } from '../../src/services/worker/gemini/RateLimitTracker.js';
import { paths } from '../../src/shared/paths.js';

const tracker = RateLimitTracker.getInstance();
afterEach(() => {
  tracker.resetAllCounters();
  tracker.setTier('free');
});

describe('Gemini Pacific daily quota', () => {
  it('keeps RPD across UTC midnight and resets at Pacific midnight', () => {
    const clock = spyOn(Date, 'now');
    try {
      clock.mockReturnValue(Date.parse('2026-01-02T00:01:00Z'));
      (tracker as any).currentQuotaDate = quotaDay(Date.now());
      tracker.calibrateRpd('gemini-pro-latest', 7);
      clock.mockReturnValue(Date.parse('2026-01-02T07:59:00Z'));
      expect(tracker.getRpdUsed('gemini-pro-latest')).toBe(7);
      clock.mockReturnValue(Date.parse('2026-01-02T08:01:00Z'));
      expect(tracker.getRpdUsed('gemini-pro-latest')).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it('finds midnight in winter and across spring and fall DST', () => {
    expect(nextDailyResetAtMs(Date.parse('2026-01-02T00:01:00Z'))).toBe(Date.parse('2026-01-02T08:00:00Z'));
    expect(nextDailyResetAtMs(Date.parse('2026-03-08T08:30:00Z'))).toBe(Date.parse('2026-03-09T07:00:00Z'));
    expect(nextDailyResetAtMs(Date.parse('2026-11-01T07:30:00Z'))).toBe(Date.parse('2026-11-02T08:00:00Z'));
    const clock = spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-08T08:30:00Z'));
    try {
      expect(tracker.getStatus().dailyResetAtMs).toBe(Date.parse('2026-03-09T07:00:00Z'));
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps legacy counts and tier when migrating a UTC-dated file', () => {
    const now = Date.now();
    (tracker as any).currentQuotaDate = quotaDay(now);
    writeFileSync(paths.geminiRateLimits(), JSON.stringify({
      date: new Date(now).toISOString().slice(0, 10), counts: { 'gemini-pro-latest': 9 }, tier: 'payg',
    }));
    (tracker as any).loadPersistedRpd();
    expect(tracker.getRpdUsed('gemini-pro-latest')).toBe(9);
    expect(tracker.getTier()).toBe('payg');
    expect(JSON.parse(readFileSync(paths.geminiRateLimits(), 'utf8')).timeZone).toBe('America/Los_Angeles');
  });
});
