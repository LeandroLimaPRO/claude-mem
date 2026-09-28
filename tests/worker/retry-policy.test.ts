import { describe, it, expect } from 'bun:test';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { isRetryableKind, withRetry } from '../../src/services/worker/retry.js';
import { setTimeout as sleep } from 'node:timers/promises';

// Pins the retry policy: quota/auth/unrecoverable errors must fail fast (no
// pointless retries of something that cannot succeed); transient and
// rate-limit errors retry; unclassified errors keep the historical
// "treat as transient" default.

const classified = (kind: string) => new ClassifiedProviderError(`test ${kind}`, { kind, cause: null });

describe('isRetryableKind', () => {
  for (const kind of ['quota_exhausted', 'auth_invalid', 'unrecoverable']) {
    it(`does not retry ${kind}`, () => {
      expect(isRetryableKind(classified(kind))).toBe(false);
    });
  }

  for (const kind of ['transient', 'rate_limit']) {
    it(`retries ${kind}`, () => {
      expect(isRetryableKind(classified(kind))).toBe(true);
    });
  }

  it('retries a plain (unclassified) Error — preserves the existing default', () => {
    expect(isRetryableKind(new Error('ECONNRESET'))).toBe(true);
  });

  it('does not retry an allowance_exhausted gateway envelope carried as quota_exhausted', () => {
    const err = new ClassifiedProviderError('You have used your allowance.', {
      kind: 'quota_exhausted',
      cause: null,
      code: 'allowance_exhausted',
      requestId: 'abc',
    });
    expect(isRetryableKind(err)).toBe(false);
  });
});

it('starts the request deadline after quota admission', async () => {
  let admitted = false;
  const result = await withRetry(async signal => {
    signal.throwIfAborted();
    return admitted;
  }, {
    maxRetries: 0,
    perAttemptTimeoutMs: 20,
    beforeAttempt: async () => {
      await sleep(60);
      admitted = true;
    },
  });
  expect(result).toBe(true);
});
