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
  private importedProxies: ProxyRecord[] = [];
  private assignments = new Map<number, ProxyRecord | null>();
  private currentReloadController: AbortController | null = null;

  constructor(
    private readonly storage: StorageManager,
    private readonly settings: SettingsManager
  ) {
    super();
  }

  async init(): Promise<void> {
    const storedProxies = await this.storage.read<ProxyRecord[]>(PROXIES_KEY, []);
    for (const p of storedProxies) this.allProxies.set(p.id, this.normalizeLoaded(this.decryptCredentials(p)));

    this.importedProxies = (await this.storage.read<ProxyRecord[]>(IMPORTED_KEY, [])).map((p) =>
      this.normalizeLoaded(p)
    );
    for (const p of this.importedProxies) this.allProxies.set(p.id, this.decryptCredentials(p));

    const storedAssignments = await this.storage.read<Array<{ browserId: number; proxyId: string | null }>>(
      ASSIGNMENTS_KEY,
      []
    );
    for (const a of storedAssignments) {
      this.assignments.set(a.browserId, a.proxyId ? this.allProxies.get(a.proxyId) ?? null : null);
    }

    logger.info('proxy', `ProxyManager initialized with ${this.allProxies.size} known proxies.`);
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

  async assign(browserId: number, proxyId: string | null): Promise<void> {
    const proxy = proxyId ? this.allProxies.get(proxyId) ?? null : null;
    this.assignments.set(browserId, proxy);
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
   * Bulk version, scoped to every currently-`working` proxy (the ones
   * actually in play for assignment) rather than the whole imported pool —
   * running this against hundreds of already-dead proxies would just be
   * hundreds of pointless real requests to Google for proxies that were
   * never going anywhere.
   */
  async checkGoogleTrustForWorking(): Promise<ProxyRecord[]> {
    const settings = this.settings.get();
    const working = Array.from(this.allProxies.values()).filter((p) => p.status === 'working');
    const results = await checkGoogleTrustMany(working, {
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
    const merged = dedupeProxies([...this.importedProxies, ...proxies]);
    this.importedProxies = merged;
    for (const p of merged) this.allProxies.set(p.id, p);
    await this.persist();

    return {
      imported: proxies.length + invalidLines.length,
      valid: proxies.length,
      invalid: invalidLines.length,
      invalidLines,
      proxies
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
    const encrypted = Array.from(this.allProxies.values()).map((p) => this.encryptCredentials(p));
    await this.storage.write(PROXIES_KEY, encrypted);
    await this.storage.write(IMPORTED_KEY, this.importedProxies.map((p) => this.encryptCredentials(p)));
    await this.storage.write(
      ASSIGNMENTS_KEY,
      Array.from(this.assignments.entries()).map(([browserId, proxy]) => ({
        browserId,
        proxyId: proxy?.id ?? null
      }))
    );
  }

  private encryptCredentials(proxy: ProxyRecord): ProxyRecord {
    if (!proxy.password) return proxy;
    return { ...proxy, password: this.storage.encryptSecret(proxy.password) };
  }

  /** Records saved before the Google-trust-check feature existed won't have
   * `googleStatus` in their persisted JSON — fill it in on load so the UI
   * and scorer never see `undefined` there. */
  private normalizeLoaded(proxy: ProxyRecord): ProxyRecord {
    return proxy.googleStatus ? proxy : { ...proxy, googleStatus: 'unknown' };
  }

  private decryptCredentials(proxy: ProxyRecord): ProxyRecord {
    if (!proxy.password) return proxy;
    try {
      return { ...proxy, password: this.storage.decryptSecret(proxy.password) };
    } catch {
      return { ...proxy, password: undefined };
    }
  }
}

/** Never send raw passwords to the renderer for the general proxy list view. */
function stripSecretsForList(proxy: ProxyRecord): ProxyRecord {
  if (!proxy.password) return proxy;
  return { ...proxy, password: '••••••••' };
}

