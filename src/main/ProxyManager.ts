import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import type {
  ProxyImportResult,
  ProxyProvider,
  ProxyProviderHealth,
  ProxyRecord,
  ReloadProxiesSummary
} from '../shared/types/proxy';
import type { SettingsManager } from './SettingsManager';
import type { StorageManager } from './StorageManager';
import { dedupeProxies, parseBulkText } from '../proxy/ProxyParser';
import { ProxyValidator } from '../proxy/ProxyValidator';
import { scoreProxy } from '../proxy/ProxyScorer';
import { assignProxies, filterByCountry } from '../proxy/ProxyAssigner';
import { PublicProxyProvider } from '../proxy/providers/PublicProxyProvider';
import { ScraperCheckerProvider } from '../proxy/providers/ScraperCheckerProvider';
import { ImportedProxyProvider } from '../proxy/providers/ImportedProxyProvider';
import { CustomProxyProvider } from '../proxy/providers/CustomProxyProvider';
import { logger } from './Logger';

const PROXIES_KEY = 'proxies';
const IMPORTED_KEY = 'imported-proxies';
const ASSIGNMENTS_KEY = 'assignments';

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- standard Node EventEmitter typed-events pattern
export declare interface ProxyManager {
  on(event: 'assignmentsChanged', listener: (summary: ReloadProxiesSummary) => void): this;
  emit(event: 'assignmentsChanged', summary: ReloadProxiesSummary): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- standard Node EventEmitter typed-events pattern
export class ProxyManager extends EventEmitter {
  private allProxies = new Map<string, ProxyRecord>();
  private importedProxies: ProxyRecord[] = [];
  private assignments = new Map<number, ProxyRecord | null>();
  private providerHealth = new Map<string, ProxyProviderHealth>();
  private currentReloadController: AbortController | null = null;

  constructor(
    private readonly storage: StorageManager,
    private readonly settings: SettingsManager
  ) {
    super();
  }

  async init(): Promise<void> {
    const storedProxies = await this.storage.read<ProxyRecord[]>(PROXIES_KEY, []);
    for (const p of storedProxies) this.allProxies.set(p.id, this.decryptCredentials(p));

    this.importedProxies = await this.storage.read<ProxyRecord[]>(IMPORTED_KEY, []);
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

  private buildProviders(countryHint: string | null): ProxyProvider[] {
    const providers: ProxyProvider[] = [];
    const settings = this.settings.get();

    if (settings.proxy.publicProvidersEnabled) {
      providers.push(new PublicProxyProvider());
    }
    if (settings.proxy.aggregatedListsEnabled) {
      providers.push(new ScraperCheckerProvider());
    }
    providers.push(new ImportedProxyProvider(() => this.importedProxies));
    for (const custom of settings.customProviders) {
      if (custom.enabled) providers.push(new CustomProxyProvider(custom));
    }

    void countryHint;
    return providers;
  }

  getAll(): ProxyRecord[] {
    return Array.from(this.allProxies.values()).map(stripSecretsForList);
  }

  getProviderHealth(): ProxyProviderHealth[] {
    return Array.from(this.providerHealth.values());
  }

  getAssignment(browserId: number): ProxyRecord | null {
    return this.assignments.get(browserId) ?? null;
  }

  getAllAssignments(): Map<number, ProxyRecord | null> {
    return this.assignments;
  }

  /**
   * Full reload pipeline: fetch from every enabled provider (each isolated
   * so one failure never blocks the others) -> dedupe -> filter by country
   * -> validate (if enabled) -> rank -> assign to browserIds -> persist.
   */
  async reload(browserIds: number[], countryCode: string | null): Promise<ReloadProxiesSummary> {
    this.currentReloadController?.abort();
    const controller = new AbortController();
    this.currentReloadController = controller;

    const settings = this.settings.get();
    const providers = this.buildProviders(countryCode);
    const providerErrors: Array<{ provider: string; reason: string }> = [];
    const fetched: ProxyRecord[] = [];

    await Promise.all(
      providers.map(async (provider) => {
        const health: ProxyProviderHealth = this.providerHealth.get(provider.name) ?? {
          name: provider.name,
          proxiesReturned: 0,
          enabled: true
        };
        try {
          // Belt-and-suspenders: providers are expected to honor `signal`
          // and their own internal per-request timeouts, but a single
          // provider that hangs for any reason (a bug, a source whose
          // response stalls mid-body in a way its own timeout didn't
          // catch) would otherwise block this whole Promise.all forever —
          // which blocks everything downstream, including assigning
          // proxies that have nothing to do with the stuck provider, like
          // imported ones. This hard outer deadline guarantees reload()
          // always finishes within a bounded time no matter what any one
          // provider does.
          const result = await withTimeout(
            provider.fetchProxies({ countryCode: countryCode ?? undefined, signal: controller.signal }),
            PROVIDER_FETCH_TIMEOUT_MS,
            `Provider "${provider.name}" timed out after ${PROVIDER_FETCH_TIMEOUT_MS}ms`
          );
          fetched.push(...result);
          health.lastRunAt = new Date().toISOString();
          health.lastSuccessAt = health.lastRunAt;
          health.lastError = undefined;
          health.proxiesReturned = result.length;
          logger.info('proxy', `Provider "${provider.name}" returned ${result.length} proxies.`);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          providerErrors.push({ provider: provider.name, reason });
          health.lastRunAt = new Date().toISOString();
          health.lastError = reason;
          logger.warn('proxy', `Provider "${provider.name}" failed: ${reason}. Continuing with remaining providers.`);
        }
        this.providerHealth.set(provider.name, health);
      })
    );

    if (controller.signal.aborted) {
      throw new Error('Proxy reload superseded by a newer request.');
    }

    // Merge freshly-fetched proxies with everything already known (so
    // previously-validated proxies aren't thrown away every reload), then dedupe.
    const merged = dedupeProxies([...Array.from(this.allProxies.values()), ...fetched]);
    for (const p of merged) this.allProxies.set(p.id, p);

    const found = merged.length;
    const countryMatched = filterByCountry(merged, countryCode).length;
    let candidates = filterByCountry(merged, countryCode);

    // Cap how many candidates go into validation. Imported proxies and
    // your own custom/API providers are exempt — only public/aggregated
    // results are capped, since those are the ones that can arrive in the
    // thousands (the aggregated-lists provider alone spans ~70 sources)
    // and would otherwise queue validation for tens of minutes at
    // maxConcurrentChecks concurrency. A random sample is taken each
    // reload rather than always the first N, so which proxies actually
    // get checked varies run to run instead of favoring whichever source
    // happened to list itself first.
    let candidatesSkipped = 0;
    const trustedSourceNames = new Set(['Imported', ...settings.customProviders.map((p) => p.name)]);
    const isTrusted = (p: ProxyRecord) => p.sources.some((s) => trustedSourceNames.has(s));
    const trusted = candidates.filter(isTrusted);
    const bulk = candidates.filter((c) => !isTrusted(c));
    const bulkBudget = Math.max(0, settings.proxy.maxCandidatesPerReload - trusted.length);
    if (bulk.length > bulkBudget) {
      const sampled = shuffle(bulk).slice(0, bulkBudget);
      candidatesSkipped = bulk.length - sampled.length;
      candidates = [...trusted, ...sampled];
    }

    if (settings.proxy.validationEnabled && candidates.length > 0) {
      const results = await ProxyValidator.validateMany(candidates, {
        timeoutMs: settings.proxy.validationTimeoutMs,
        ipCheckUrl: settings.proxy.ipCheckUrl,
        maxConcurrent: settings.proxy.maxConcurrentChecks,
        signal: controller.signal
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
      assignments,
      providerErrors,
      candidatesSkipped
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

/** Hard ceiling on how long ProxyManager.reload() will wait for any single
 * provider's fetchProxies() to settle, regardless of what that provider
 * does internally. ScraperCheckerProvider alone can take up to roughly
 * (source count / concurrency) * per-fetch timeout in the worst case
 * (~90 sources / 12 concurrent * 10s ≈ 75s), so this is set comfortably
 * above that rather than the per-fetch timeout itself. */
const PROVIDER_FETCH_TIMEOUT_MS = 90000;

/** Exported for unit testing — see tests/withTimeout.test.ts. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Fisher-Yates shuffle, used to take a fair random sample of candidates
 * when maxCandidatesPerReload trims the bulk (public/aggregated) pool. */
function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
