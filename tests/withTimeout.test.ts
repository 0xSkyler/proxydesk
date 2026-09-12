import { describe, expect, it } from 'vitest';
import { withTimeout } from '../src/main/ProxyManager';

/**
 * Guards against a regression of the reload-hang bug: a provider (or
 * anything else async) that never settles must not be able to block
 * whatever awaits it forever — withTimeout is the outer safety net for
 * that, independent of whatever timeout logic the inner promise itself
 * does or doesn't implement correctly.
 */
describe('withTimeout', () => {
  it('resolves with the inner value when it settles before the deadline', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 100, 'should not fire');
    expect(result).toBe('ok');
  });

  it('rejects with the inner error when it rejects before the deadline', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 100, 'should not fire')).rejects.toThrow('boom');
  });

  it('rejects with the timeout message when the inner promise never settles', async () => {
    const neverSettles = new Promise<string>(() => {
      /* intentionally never resolves or rejects */
    });
    await expect(withTimeout(neverSettles, 20, 'timed out')).rejects.toThrow('timed out');
  });
});
