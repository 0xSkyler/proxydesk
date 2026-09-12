import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock node:https so we can simulate a request that never fires 'end',
// 'error', 'timeout', or 'abort' — exactly the scenario that used to hang
// ProxyValidator.validate() forever (see the "backstop" comment in
// ProxyValidator.ts). The mock request is a bare event-emitter-ish stub;
// none of its handlers are ever invoked by this test, on purpose.
vi.mock('node:https', () => {
  return {
    default: {
      request: vi.fn(() => {
        const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
        const req = {
          on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            (handlers[event] ??= []).push(handler);
            return req;
          }),
          destroy: vi.fn(),
          end: vi.fn()
          // Intentionally never calls any registered handler — simulates a
          // proxy connection that neither completes, errors, times out at
          // the socket level, nor aborts.
        };
        return req as unknown as ReturnType<typeof import('node:https').request>;
      })
    }
  };
});

vi.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: vi.fn().mockImplementation(() => ({}))
}));
vi.mock('socks-proxy-agent', () => ({
  SocksProxyAgent: vi.fn().mockImplementation(() => ({}))
}));

import { ProxyValidator } from '../src/proxy/ProxyValidator';
import { toProxyRecord } from '../src/proxy/ProxyParser';

describe('ProxyValidator.validate backstop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves as dead via the wall-clock backstop when the request never fires any terminal event', async () => {
    const proxy = toProxyRecord({ host: '10.0.0.1', port: 8080, protocol: 'http' }, 'test', {});

    const resultPromise = ProxyValidator.validate(proxy, { timeoutMs: 1000 });

    // Advance past timeoutMs + the backstop's extra 1000ms grace period.
    // Neither 'timeout', 'error', nor 'end' ever fires on the mocked
    // request, so only the backstop timer can settle this promise.
    await vi.advanceTimersByTimeAsync(2500);

    const result = await resultPromise;
    expect(result.status).toBe('dead');
    expect(result.error).toBe('Validation timed out');
  });
});
