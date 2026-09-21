import { EventEmitter } from 'node:events';
import type {
  ProxyAssignment,
  ProxyRecord,
  ReloadProgress,
  ReloadProxiesSummary
} from '../shared/types/proxy';
import { dedupeProxies, parseBulkText } from '../proxy/ProxyParser';
import { ProxyValidator } from '../proxy/ProxyValidator';
import { scoreProxy } from '../proxy/ProxyScorer';
import { fetchProxyScrapeFreeList } from '../proxy/ProxyScrapeProvider';
import { logger } from './Logger';

const VALIDATION_TIMEOUT_MS = 6000;
const MAX_CONCURRENT_CHECKS = 32;
const IP_CHECK_URL = 'https://api.ipify.org?format=json';

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface ProxyManager {
  on(event: 'assignmentsChanged', listener: (summary: ReloadProxiesSummary) => void): this;
  emit(event: 'assignmentsChanged', summary: ReloadProxiesSummary): boolean;
  on(event: 'reloadProgress', listener: (progress: ReloadProgress) => void): this;
  emit(event: 'reloadProgress', progress: ReloadProgress): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ProxyManager extends EventEmitter {
  private allProxies = new Map<string, ProxyRecord>();
  private assignments = new Map<number, ProxyRecord | null>();
  private validationController: AbortController | null = null;
  private usedProxyIds = new Set<string>();

  async init(): Promise<void> {
    this.allProxies.clear();
    this.assignments.clear();
    this.usedProxyIds.clear();
    logger.info('proxy', 'Proxy manager ready: ProxyScrape API source, session-only state.');
  }

  getAll(): ProxyRecord[] {
    return Array.from(this.allProxies.values()).map((proxy) => ({ ...proxy, password: undefined }));
  }

  getAssignment(browserId: number): ProxyRecord | null {
    return this.assignments.get(browserId) ?? null;
  }

  resetRotationHistory(): void {
    this.usedProxyIds.clear();
  }

  cancelCurrentValidation(): void {
    this.validationController?.abort();
    this.validationController = null;
  }

  /**
   * Fetches ProxyScrape's public feed, validates it locally, and assigns live
   * proxies immediately as individual validation results arrive.
   *
   * One proxy is exclusive to one browser in a cycle. Across cycles, proxies
   * already used by automation stay ineligible until the available live pool
   * has been exhausted, at which point a new rotation round begins.
   */
  async fetchValidateAssignStreaming(
    browserIds: number[],
    onAssignment: (assignment: ProxyAssignment, checked: number, total: number) => void,
    onProgress?: (checked: number, total: number, working: number, assigned: number, fetched: number) => void
  ): Promise<ReloadProxiesSummary> {
    this.cancelCurrentValidation();
    const controller = new AbortController();
    this.validationController = controller;

    const previousAssignments = new Map(this.assignments);

    const raw = await fetchProxyScrapeFreeList({
      limit: 2000,
      timeoutFilterMs: VALIDATION_TIMEOUT_MS,
      requestTimeoutMs: 15_000,
      signal: controller.signal
    });

    if (controller.signal.aborted) throw new Error('Proxy validation cancelled.');

    const parsed = parseBulkText(raw, 'ProxyScrape Free API');
    const replacement = dedupeProxies(parsed.proxies);
    if (replacement.length === 0) {
      throw new Error('ProxyScrape returned no usable proxies.');
    }

    // Keep rotation history only for endpoints that still exist in the newly
    // fetched public feed.
    const replacementIds = new Set(replacement.map((proxy) => proxy.id));
    for (const id of Array.from(this.usedProxyIds)) {
      if (!replacementIds.has(id)) this.usedProxyIds.delete(id);
    }
    if (replacement.every((proxy) => this.usedProxyIds.has(proxy.id))) {
      this.usedProxyIds.clear();
    }

    this.allProxies.clear();
    this.assignments.clear();
    for (const proxy of replacement) {
      this.allProxies.set(proxy.id, { ...proxy, status: 'checking' });
    }

    const candidates = Array.from(this.allProxies.values());
    const total = candidates.length;
    const remainingBrowsers = new Set(browserIds);
    const usedThisCycle = new Set<string>();
    let working = 0;
    let assigned = 0;

    const emitProgress = (checked: number) => {
      this.emit('reloadProgress', { checked, total });
      onProgress?.(checked, total, working, assigned, replacement.length);
    };

    emitProgress(0);

    const chooseBrowser = (proxy: ProxyRecord): number | null => {
      if (this.usedProxyIds.has(proxy.id) || usedThisCycle.has(proxy.id)) return null;
      const ids = Array.from(remainingBrowsers);
      if (ids.length === 0) return null;
      return ids.find((id) => previousAssignments.get(id)?.id !== proxy.id) ?? ids[0] ?? null;
    };

    const results = await ProxyValidator.validateMany(candidates, {
      timeoutMs: VALIDATION_TIMEOUT_MS,
      ipCheckUrl: IP_CHECK_URL,
      maxConcurrent: MAX_CONCURRENT_CHECKS,
      signal: controller.signal,
      onResult: (result, checked, resultTotal) => {
        if (controller.signal.aborted) return;
        const proxy = this.allProxies.get(result.proxyId);
        if (!proxy) return;

        proxy.status = result.status;
        proxy.latencyMs = result.latencyMs;
        proxy.lastChecked = result.checkedAt;
        if (result.status === 'working') {
          proxy.successCount += 1;
          working += 1;
        } else {
          proxy.failureCount += 1;
        }
        proxy.score = scoreProxy(proxy);
        this.allProxies.set(proxy.id, proxy);

        if (result.status === 'working') {
          const browserId = chooseBrowser(proxy);
          if (browserId != null) {
            this.assignments.set(browserId, proxy);
            remainingBrowsers.delete(browserId);
            usedThisCycle.add(proxy.id);
            this.usedProxyIds.add(proxy.id);
            assigned += 1;
            onAssignment({ browserId, proxy }, checked, resultTotal);
            this.emitAssignments(browserIds, replacement.length, working);
          }
        }

        this.emit('reloadProgress', { checked, total: resultTotal });
        onProgress?.(checked, resultTotal, working, assigned, replacement.length);
      }
    });

    if (controller.signal.aborted || this.validationController !== controller) {
      return this.summary(browserIds, replacement.length, working);
    }

    // Preserve final states from the validator.
    for (const result of results) {
      const proxy = this.allProxies.get(result.proxyId);
      if (!proxy) continue;
      proxy.status = result.status;
      proxy.latencyMs = result.latencyMs;
      proxy.lastChecked = result.checkedAt;
      proxy.score = scoreProxy(proxy);
      this.allProxies.set(proxy.id, proxy);
    }

    // If every live endpoint has already been consumed in earlier rounds,
    // begin a new round and fill any browsers that did not receive a proxy.
    const live = Array.from(this.allProxies.values()).filter((proxy) => proxy.status === 'working');
    if (
      remainingBrowsers.size > 0 &&
      live.length > 0 &&
      live.every((proxy) => this.usedProxyIds.has(proxy.id))
    ) {
      this.usedProxyIds.clear();
      for (const browserId of Array.from(remainingBrowsers)) {
        const eligible = live.filter((proxy) => !usedThisCycle.has(proxy.id));
        if (eligible.length === 0) break;
        const previousId = previousAssignments.get(browserId)?.id;
        const proxy = eligible.find((candidate) => candidate.id !== previousId) ?? eligible[0];
        this.assignments.set(browserId, proxy);
        remainingBrowsers.delete(browserId);
        usedThisCycle.add(proxy.id);
        this.usedProxyIds.add(proxy.id);
        assigned += 1;
        onAssignment({ browserId, proxy }, total, total);
      }
    }

    emitProgress(total);
    const summary = this.summary(browserIds, replacement.length, working);
    this.emit('assignmentsChanged', summary);
    if (this.validationController === controller) this.validationController = null;
    return summary;
  }

  private emitAssignments(browserIds: number[], found: number, working: number): void {
    this.emit('assignmentsChanged', this.summary(browserIds, found, working));
  }

  private summary(browserIds: number[], found: number, working: number): ReloadProxiesSummary {
    return {
      found,
      countryMatched: found,
      working,
      assignments: browserIds.map((browserId) => ({
        browserId,
        proxy: this.assignments.get(browserId) ?? null
      }))
    };
  }
}
