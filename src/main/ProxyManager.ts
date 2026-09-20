import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import type { ProxyImportResult, ProxyRecord, ReloadProgress, ReloadProxiesSummary } from '../shared/types/proxy';
import type { SettingsManager } from './SettingsManager';
import type { StorageManager } from './StorageManager';
import { dedupeProxies, parseBulkText } from '../proxy/ProxyParser';
import { ProxyValidator } from '../proxy/ProxyValidator';
import { checkGoogleTrust, checkGoogleTrustMany } from '../proxy/GoogleTrustChecker';
import { scoreProxy } from '../proxy/ProxyScorer';
import { assignProxies, filterByCountry } from '../proxy/ProxyAssigner';
import { logger } from './Logger';

const PROXIES_KEY = 'proxies';
const IMPORTED_KEY = 'imported-proxies';
const ASSIGNMENTS_KEY = 'assignments';

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- standard Node EventEmitter typed-events pattern
export declare interface ProxyManager {
  on(event: 'assignmentsChanged', listener: (summary: ReloadProxiesSummary) => void): this;
  emit(event: 'assignmentsChanged', summary: ReloadProxiesSummary): boolean;
  on(event: 'reloadProgress', listener: (progress: ReloadProgress) => void): this;
  emit(event: 'reloadProgress', progress: ReloadProgress): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- standard Node EventEmitter typed-events pattern
export class ProxyManager extends EventEmitter {
  private allProxies = new Map<string, ProxyRecord>();
  private assignments = new Map<number, ProxyRecord | null>();
  private currentReloadController: AbortController | null = null;
  private rotationOffset = 0;

  constructor(
    private readonly storage: StorageManager,
    private readonly settings: SettingsManager
  ) {
    super();
  }

  async init(): Promise<void> {
    // Proxy state is intentionally session-only. Purge any files written by
    // older builds so a restart always begins with an empty proxy pool.
    await Promise.all([
      this.storage.remove(PROXIES_KEY),
      this.storage.remove(IMPORTED_KEY),
      this.storage.remove(ASSIGNMENTS_KEY)
    ]);
    this.allProxies.clear();
    this.assignments.clear();
    logger.info('proxy', 'ProxyManager initialized with an empty session-only proxy pool.');
  }

  getAll(): ProxyRecord[] {
    return Array.from(this.allProxies.values()).map(stripSecretsForList);
  }

  getAssignment(browserId: number): ProxyRecord | null {
    return this.assignments.get(browserId) ?? null;
  }

  getAllAssignments(): Map<number, ProxyRecord | null> {
    return this.assignments;
  }

  /**
   * Validate-and-assign pipeline over every proxy already known to the app
   * (in practice: whatever was manually imported via Import Proxies, plus
   * anything imported in a previous session) — filter by country -> validate
   * (if enabled) -> rank -> assign to browserIds -> persist. There is no
   * fetch/discovery step: proxies only ever enter the pool through import.
   */
  async reload(browserIds: number[], countryCode: string | null): Promise<ReloadProxiesSummary> {
    this.currentReloadController?.abort();
    const controller = new AbortController();
    this.currentReloadController = controller;

    const settings = this.settings.get();

    const known = dedupeProxies(Array.from(this.allProxies.values()));
    for (const p of known) this.allProxies.set(p.id, p);

    const found = known.length;
    const countryMatched = filterByCountry(known, countryCode).length;
    let candidates = filterByCountry(known, countryCode);

    if (settings.proxy.validationEnabled && candidates.length > 0) {
      this.emit('reloadProgress', { checked: 0, total: candidates.length });
      const results = await ProxyValidator.validateMany(candidates, {
        timeoutMs: settings.proxy.validationTimeoutMs,
        ipCheckUrl: settings.proxy.ipCheckUrl,
        maxConcurrent: settings.proxy.maxConcurrentChecks,
        signal: controller.signal,
        onProgress: (checked, total) => this.emit('reloadProgress', { checked, total })
      });
      for (const result of results) {
        const proxy = this.allProxies.get(result.proxyId);
        if (!proxy) continue;
        proxy.status = result.status;
        proxy.latencyMs = result.latencyMs;
        proxy.lastChecked = result.checkedAt;
        if (result.status === 'working') proxy.successCount += 1;
        else proxy.failureCount += 1;
        proxy.score = scoreProxy(proxy);
        this.allProxies.set(proxy.id, proxy);
      }
      candidates = candidates.map((c) => this.allProxies.get(c.id)!).filter(Boolean);
    } else {
      candidates = candidates.map((c) => {
        const withScore = { ...c, score: scoreProxy(c) };
        this.allProxies.set(c.id, withScore);
        return withScore;
      });
    }

    const working = candidates.filter((c) => c.status === 'working').length;

    const assignments = assignProxies(candidates, {
      browserIds,
      allowProxyReuse: settings.proxy.allowProxyReuse,
      currentAssignments: this.assignments
    });

    for (const a of assignments) this.assignments.set(a.browserId, a.proxy);

    await this.persist();

    const summary: ReloadProxiesSummary = {
      found,
      countryMatched,
      working,
      assignments
    };
    this.emit('assignmentsChanged', summary);
    return summary;
  }

  /**
   * Reassigns from the already-known proxy pool without revalidating the
   * complete list on every timer tick. Previously-confirmed working proxies
   * are preferred when validation is enabled.
   */
  async rotate(browserIds: number[], countryCode: string | null): Promise<ReloadProxiesSummary> {
    const settings = this.settings.get();
    const known = dedupeProxies(Array.from(this.allProxies.values()));
    const countryFiltered = filterByCountry(known, countryCode).filter((p) => p.status !== 'dead');
    const confirmed = countryFiltered.filter((p) => p.status === 'working');
    const candidates = settings.proxy.validationEnabled && confirmed.length > 0 ? confirmed : countryFiltered;

    const offset = candidates.length === 0 ? 0 : this.rotationOffset % candidates.length;
    const assignments = assignProxies(candidates, {
      browserIds,
      allowProxyReuse: settings.proxy.allowProxyReuse,
      currentAssignments: this.assignments,
      keepExisting: false,
      startOffset: offset
    });

    this.rotationOffset =
      candidates.length === 0 ? 0 : (offset + Math.max(1, browserIds.length)) % candidates.length;

    for (const assignment of assignments) this.assignments.set(assignment.browserId, assignment.proxy);
    await this.persist();

    const summary: ReloadProxiesSummary = {
      found: known.length,
      countryMatched: countryFiltered.length,
      working: confirmed.length,
      assignments
    };
    this.emit('assignmentsChanged', summary);
    return summary;
  }

  async assign(browserId: number, proxyId: string | null): Promise<void> {
    const proxy = proxyId ? this.allProxies.get(proxyId) ?? null : null;
    this.assignments.set(browserId, proxy);
    await this.persist();
  }

  /**
   * Records that the proxy currently assigned to `browserId` just got a
   * live Google CAPTCHA hit (see BrowserManager.onGoogleBlocked) — i.e. the
   * exact signal the deliberate "Check Google Trust" feature looks for,
   * just discovered by actually browsing instead. No-op if that browser has
   * no assigned proxy (shouldn't happen — a block can only occur while
   * routed through one — but never worth throwing over).
   */
  async markGoogleBlocked(browserId: number): Promise<void> {
    const proxy = this.assignments.get(browserId);
    if (!proxy) return;
    proxy.googleStatus = 'blocked';
    proxy.googleCheckedAt = new Date().toISOString();
    proxy.score = scoreProxy(proxy);
    this.allProxies.set(proxy.id, proxy);
    await this.persist();
  }

  async replaceFailed(browserId: number, excludeIds: Set<string> = new Set()): Promise<ProxyRecord | null> {
    const settings = this.settings.get();
    const current = this.assignments.get(browserId);
    if (current) excludeIds.add(current.id);
    for (const [, p] of this.assignments) if (p) excludeIds.add(p.id);

    const candidates = Array.from(this.allProxies.values())
      .filter((p) => !excludeIds.has(p.id) && p.status !== 'dead')
      .sort((a, b) => b.score - a.score);

    for (const candidate of candidates) {
      const result = await ProxyValidator.validate(candidate, {
        timeoutMs: settings.proxy.validationTimeoutMs,
        ipCheckUrl: settings.proxy.ipCheckUrl
      });
      candidate.status = result.status;
      candidate.latencyMs = result.latencyMs;
      candidate.lastChecked = result.checkedAt;
      if (result.status === 'working') candidate.successCount += 1;
      else candidate.failureCount += 1;
      candidate.score = scoreProxy(candidate);
      this.allProxies.set(candidate.id, candidate);

      if (result.status === 'working') {
        this.assignments.set(browserId, candidate);
        await this.persist();
        return candidate;
      }
    }

    return null;
  }

  async validate(proxyId: string): Promise<ProxyRecord> {
    const proxy = this.allProxies.get(proxyId);
    if (!proxy) throw new Error(`Unknown proxy: ${proxyId}`);
    const settings = this.settings.get();
    const result = await ProxyValidator.validate(proxy, {
      timeoutMs: settings.proxy.validationTimeoutMs,
      ipCheckUrl: settings.proxy.ipCheckUrl
    });
    proxy.status = result.status;
    proxy.latencyMs = result.latencyMs;
    proxy.lastChecked = result.checkedAt;
    if (result.status === 'working') proxy.successCount += 1;
    else proxy.failureCount += 1;
    proxy.score = scoreProxy(proxy);
    this.allProxies.set(proxy.id, proxy);
    await this.persist();
    return proxy;
  }

  async validateAll(): Promise<ProxyRecord[]> {
    const settings = this.settings.get();
    const proxies = Array.from(this.allProxies.values());
    const results = await ProxyValidator.validateMany(proxies, {
      timeoutMs: settings.proxy.validationTimeoutMs,
      ipCheckUrl: settings.proxy.ipCheckUrl,
      maxConcurrent: settings.proxy.maxConcurrentChecks
    });
    for (const result of results) {
      const proxy = this.allProxies.get(result.proxyId);
      if (!proxy) continue;
      proxy.status = result.status;
      proxy.latencyMs = result.latencyMs;
      proxy.lastChecked = result.checkedAt;
      if (result.status === 'working') proxy.successCount += 1;
      else proxy.failureCount += 1;
      proxy.score = scoreProxy(proxy);
      this.allProxies.set(proxy.id, proxy);
    }
    await this.persist();
    return this.getAll();
  }

  /**
   * Routes one real Google Search request through this proxy and records
   * whether Google served a normal results page or its "unusual traffic"
   * interstitial (see GoogleTrustChecker). Deliberately separate from
   * validate()/validateAll() — this is a much heavier, slower, Google-
   * specific request, not a bare connectivity check, so it only ever runs
   * when explicitly asked for (a single "Check Google" click, or the bulk
   * "Check Google Trust" action below), never as part of every reload.
   */
  async checkGoogleTrustFor(proxyId: string): Promise<ProxyRecord> {
    const proxy = this.allProxies.get(proxyId);
    if (!proxy) throw new Error(`Unknown proxy: ${proxyId}`);
    const settings = this.settings.get();
    const result = await checkGoogleTrust(proxy, { timeoutMs: settings.proxy.validationTimeoutMs });
    proxy.googleStatus = result.status;
    proxy.googleCheckedAt = result.checkedAt;
    proxy.score = scoreProxy(proxy);
    this.allProxies.set(proxy.id, proxy);
    await this.persist();
    return proxy;
  }

  /**
   * Bulk version, scoped to every proxy actually assigned to a browser
   * right now (i.e. currently in play), rather than the whole imported
   * pool — running this against hundreds of unused/dead proxies would just
   * be hundreds of pointless real requests to Google for proxies that were
   * never going anywhere.
   *
   * Deliberately keyed off `this.assignments`, not `status === 'working'`:
   * with "Validate proxies before assigning" turned off (see
   * ProxySettings.validationEnabled), an assigned proxy's status stays
   * 'unknown' forever — it was never run through the connectivity check —
   * so filtering on 'working' here would silently find nothing to check in
   * exactly the fast-assign workflow this bulk action is most useful for.
   */
  async checkGoogleTrustForWorking(): Promise<ProxyRecord[]> {
    const settings = this.settings.get();
    const assignedIds = new Set(
      Array.from(this.assignments.values())
        .filter((p): p is ProxyRecord => p != null)
        .map((p) => p.id)
    );
    const assigned = Array.from(this.allProxies.values()).filter((p) => assignedIds.has(p.id));
    const results = await checkGoogleTrustMany(assigned, {
      timeoutMs: settings.proxy.validationTimeoutMs,
      maxConcurrent: 3
    });
    for (const result of results) {
      const proxy = this.allProxies.get(result.proxyId);
      if (!proxy) continue;
      proxy.googleStatus = result.status;
      proxy.googleCheckedAt = result.checkedAt;
      proxy.score = scoreProxy(proxy);
      this.allProxies.set(proxy.id, proxy);
    }
    await this.persist();
    return this.getAll();
  }

  async importText(text: string): Promise<ProxyImportResult> {
    const { proxies, invalidLines } = parseBulkText(text, 'Imported');
    const replacement = dedupeProxies(proxies);

    // Every import replaces the current runtime pool. This guarantees that
    // only proxies from the most recently uploaded/pasted list are eligible.
    this.allProxies.clear();
    this.assignments.clear();
    for (const proxy of replacement) this.allProxies.set(proxy.id, proxy);

    return {
      imported: proxies.length + invalidLines.length,
      valid: replacement.length,
      invalid: invalidLines.length,
      invalidLines,
      proxies: replacement
    };
  }

  async importFile(filePath: string): Promise<ProxyImportResult> {
    const text = await fs.readFile(filePath, 'utf8');
    return this.importText(text);
  }

  async exportProxies(format: 'txt' | 'csv' | 'json'): Promise<string> {
    const proxies = this.getAll();
    if (format === 'json') return JSON.stringify(proxies, null, 2);

    if (format === 'csv') {
      const header = 'host,port,protocol,country,username,password';
      const rows = proxies.map(
        (p) => `${p.host},${p.port},${p.protocol},${p.countryCode ?? ''},${p.username ?? ''},${p.password ?? ''}`
      );
      return [header, ...rows].join('\n');
    }

    return proxies.map((p) => `${p.protocol}://${p.host}:${p.port}`).join('\n');
  }

  private async persist(): Promise<void> {
    // Deliberately no-op: proxy pool, credentials, assignments and usage
    // history live only in memory for the lifetime of this app process.
  }
}

/** Never send raw passwords to the renderer for the general proxy list view. */
function stripSecretsForList(proxy: ProxyRecord): ProxyRecord {
  if (!proxy.password) return proxy;
  return { ...proxy, password: '••••••••' };
}

