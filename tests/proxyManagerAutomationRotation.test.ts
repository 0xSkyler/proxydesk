import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProxyManager } from '../src/main/ProxyManager';
import { ProxyValidator } from '../src/proxy/ProxyValidator';
import type { ProxyValidationResult } from '../src/shared/types/proxy';
import type { SettingsManager } from '../src/main/SettingsManager';
import type { StorageManager } from '../src/main/StorageManager';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('ProxyManager autonomous rotation history', () => {
  it('exhausts unique proxies across cycles before reusing them and never shares one in a cycle', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxydesk-rotation-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'proxy.txt');
    await fs.writeFile(
      filePath,
      ['127.0.0.1:8101', '127.0.0.1:8102', '127.0.0.1:8103', '127.0.0.1:8104'].join('\n'),
      'utf8'
    );

    vi.spyOn(ProxyValidator, 'validate').mockImplementation(async (proxy) => {
      const result: ProxyValidationResult = {
        proxyId: proxy.id,
        status: 'working',
        latencyMs: 10,
        checkedAt: new Date(0).toISOString()
      };
      return result;
    });

    const storage = {
      async remove() {
        return undefined;
      }
    } as unknown as StorageManager;

    const settings = {
      get() {
        return {
          proxy: {
            validationTimeoutMs: 1000,
            ipCheckUrl: 'https://example.test/ip',
            maxConcurrentChecks: 4,
            allowProxyReuse: true
          }
        };
      }
    } as unknown as SettingsManager;

    const manager = new ProxyManager(storage, settings);
    await manager.init();
    manager.resetAutomationRotationHistory();

    async function runCycle(): Promise<string[]> {
      const assigned: string[] = [];
      await manager.validateFileStreaming(filePath, [1, 2], null, (assignment) => {
        if (assignment.proxy) assigned.push(assignment.proxy.id);
      });
      return assigned;
    }

    const first = await runCycle();
    const second = await runCycle();
    const third = await runCycle();

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(new Set(first).size).toBe(2);
    expect(new Set(second).size).toBe(2);
    expect(first.some((id) => second.includes(id))).toBe(false);
    expect(new Set([...first, ...second]).size).toBe(4);

    // After all four live proxies have been consumed, a new rotation round
    // is allowed to reuse the pool. It still stays exclusive within cycle 3.
    expect(third).toHaveLength(2);
    expect(new Set(third).size).toBe(2);
    expect(third.some((id) => first.includes(id) || second.includes(id))).toBe(true);
  });
});
