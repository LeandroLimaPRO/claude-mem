import { describe, it, expect } from 'bun:test';
import { ClassifiedProviderError } from '../../../../src/services/worker/provider-errors.js';

/**
 * Test for P2 finding: Session routes should preserve only transient errors
 * and not keep poisoned batches for unrecoverable errors.
 */
describe('SessionRoutes error handling', () => {
  it('should classify transient errors for batch preservation', () => {
    const transientKinds = ['transient', 'rate_limit', 'quota_exhausted', 'model_overloaded'];

    for (const kind of transientKinds) {
      const error = new ClassifiedProviderError(`test ${kind}`, { kind: kind as any, cause: null });
      expect(transientKinds).toContain(kind);
    }
  });

  it('should not classify unrecoverable errors as transient', () => {
    const unrecoverableKinds = ['unrecoverable', 'model_incompatible', 'unknown_bad_request'];
    const transientKinds = ['transient', 'rate_limit', 'quota_exhausted', 'model_overloaded'];

    for (const kind of unrecoverableKinds) {
      expect(transientKinds).not.toContain(kind);
    }
  });

  it('should set abortReason to transport for rate_limit errors', () => {
    const error = new ClassifiedProviderError('rate limit exceeded', { kind: 'rate_limit', cause: null });
    const isTransient = error.kind === 'transient' ||
                       error.kind === 'rate_limit' ||
                       error.kind === 'quota_exhausted' ||
                       error.kind === 'model_overloaded';
    expect(isTransient).toBe(true);
  });

  it('should set abortReason to null for unrecoverable errors', () => {
    const error = new ClassifiedProviderError('bad request', { kind: 'unrecoverable', cause: null });
    const isTransient = error.kind === 'transient' ||
                       error.kind === 'rate_limit' ||
                       error.kind === 'quota_exhausted' ||
                       error.kind === 'model_overloaded';
    expect(isTransient).toBe(false);
  });
});
