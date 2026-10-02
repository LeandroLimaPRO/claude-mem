import { afterEach, describe, it, expect } from 'bun:test';
import { RateLimitTracker } from '../../src/services/worker/gemini/RateLimitTracker.js';

describe('RateLimitTracker unknown model handling', () => {
  const tracker = RateLimitTracker.getInstance();
  afterEach(() => { tracker.resetAllCounters(); tracker.setAutoFallback(true); });

  it('cascades from an unknown model when autoFallback is enabled', () => {
    tracker.setAutoFallback(true);
    expect(tracker.selectBestAvailableModel('model-missing-from-discovery', 100).selectedModel.id).toBeTruthy();
  });

  it('refuses to swap an unknown model when autoFallback is disabled', () => {
    tracker.setAutoFallback(false);
    expect(() => tracker.selectBestAvailableModel('model-missing-from-discovery', 100)).toThrow(/Unknown Gemini model/);
  });
});
