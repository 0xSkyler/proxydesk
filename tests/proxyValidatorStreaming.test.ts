import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProxyValidator } from '../src/proxy/ProxyValidator';
import type { ProxyRecord, ProxyValidationResult } from '../src/shared/types/proxy';

function proxy(id: string): ProxyRecord {
  return {
    id,
    host: `${id}.example.test`,
    port: 8080,
    protocol: 'http',
    countryVerified: false,
    sources: ['test'],
    status: 'unknown',
    score: 0,
    successCount: 0,
    failureCount: 0,
    googleStatus: 'unknown'
  };
}

function result(id: string): ProxyValidationResult {
  return {
    proxyId: id,
    status: 'working',
    latencyMs: 10,
    checkedAt: new Date(0).toISOString()
  };
}

describe('ProxyValidator.validateMany streaming', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits an individual result before the whole validation batch completes', async () => {
    let resolveFirst!: (value: ProxyValidationResult) => void;
    let resolveSecond!: (value: ProxyValidationResult) => void;

    vi.spyOn(ProxyValidator, 'validate').mockImplementation((item) => {
      return new Promise<ProxyValidationResult>((resolve) => {
        if (item.id === 'p1') resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });

    const streamed: string[] = [];
    let batchFinished = false;
    const batch = ProxyValidator.validateMany([proxy('p1'), proxy('p2')], {
      maxConcurrent: 2,
      onResult: (item) => streamed.push(item.proxyId)
    }).then((value) => {
      batchFinished = true;
      return value;
    });

    resolveFirst(result('p1'));
    await Promise.resolve();
    await Promise.resolve();

    expect(streamed).toEqual(['p1']);
    expect(batchFinished).toBe(false);

    resolveSecond(result('p2'));
    const final = await batch;

    expect(streamed).toEqual(['p1', 'p2']);
    expect(final.map((item) => item.proxyId).sort()).toEqual(['p1', 'p2']);
    expect(batchFinished).toBe(true);
  });
});
