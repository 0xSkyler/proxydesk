import { EventEmitter } from 'node:events';
import type {
  ProxyEndpoint,
  ProxyFetchSummary,
  TrackerConfig,
  TrackerResult,
  TrackerState
} from '../shared/tracker';
import { ProxyScrapeService } from './ProxyScrapeService';
import { SeoBrowserManager } from './SeoBrowserManager';

const MAX_PROXY_ATTEMPTS_PER_BROWSER = 3;

export class SeoTrackerManager extends EventEmitter {
  private generation = 0;
  private proxyCursor = 0;
  private state: TrackerState = {
    running: false,
    proxiesFetched: 0,
    browserCount: 4,
    results: []
  };

  constructor(
    private readonly browsers: SeoBrowserManager,
    private readonly proxySource: ProxyScrapeService
  ) {
    super();
  }

  getState(): TrackerState {
    return {
      ...this.state,
      results: this.state.results.map((result) => ({ ...result }))
    };
  }

  async refreshProxies(): Promise<ProxyFetchSummary> {
    const summary = await this.proxySource.refresh();
    this.state = { ...this.state, proxiesFetched: summary.fetched };
    this.emitState();
    return summary;
  }

  async start(input: TrackerConfig): Promise<TrackerState> {
    const config = normalizeConfig(input);
    this.stop();

    const generation = ++this.generation;
    this.proxyCursor = 0;

    await this.browsers.syncCount(config.browserCount);

    const summary = await this.proxySource.refresh();
    const proxies = await this.proxySource.get(config.proxyFilter);
    if (proxies.length === 0) {
      throw new Error(`ProxyScrape returned no proxies for ${config.proxyFilter}.`);
    }

    this.state = {
      running: true,
      proxiesFetched: summary.fetched,
      browserCount: config.browserCount,
      startedAt: new Date().toISOString(),
      results: []
    };
    this.emitState();

    const tasks = Array.from({ length: config.browserCount }, (_, index) =>
      this.runBrowser(index + 1, config, proxies, generation)
    );

    void Promise.all(tasks).then(() => {
      if (generation !== this.generation) return;
      this.state = { ...this.state, running: false };
      this.emitState();
    });

    return this.getState();
  }

  stop(): TrackerState {
    this.generation += 1;
    this.browsers.stopAll();
    if (this.state.running) {
      this.state = { ...this.state, running: false };
      this.emitState();
    }
    return this.getState();
  }

  private async runBrowser(
    browserId: number,
    config: TrackerConfig,
    proxies: ProxyEndpoint[],
    generation: number
  ): Promise<void> {
    let lastError: TrackerResult | null = null;

    for (let attempt = 0; attempt < MAX_PROXY_ATTEMPTS_PER_BROWSER; attempt += 1) {
      if (generation !== this.generation) return;

      const proxy = proxies[this.proxyCursor % proxies.length];
      this.proxyCursor += 1;

      try {
        await this.browsers.assignProxy(browserId, proxy);
      } catch (err) {
        lastError = {
          browserId,
          status: 'error',
          proxy,
          error: `Could not apply proxy: ${(err as Error).message}`,
          finishedAt: new Date().toISOString()
        };
        continue;
      }

      const result = await this.browsers.search(
        browserId,
        config.query,
        config.target,
        config.maxPages
      );

      if (generation !== this.generation) return;

      // Connection/runtime errors can use another public proxy. A Google
      // challenge is reported as blocked and is not automatically bypassed.
      if (result.status === 'error' && attempt + 1 < MAX_PROXY_ATTEMPTS_PER_BROWSER) {
        lastError = result;
        continue;
      }

      this.recordResult(result);
      return;
    }

    if (lastError && generation === this.generation) this.recordResult(lastError);
  }

  private recordResult(result: TrackerResult): void {
    const results = this.state.results.filter((item) => item.browserId !== result.browserId);
    results.push(result);
    results.sort((a, b) => a.browserId - b.browserId);
    this.state = { ...this.state, results };
    this.emit('result', { ...result });
    this.emitState();
  }

  private emitState(): void {
    this.emit('stateChanged', this.getState());
  }
}

function normalizeConfig(input: TrackerConfig): TrackerConfig {
  const query = input.query.trim();
  const target = input.target.trim();
  if (!query) throw new Error('Enter a Google search query.');
  if (!target) throw new Error('Enter a target website or site name.');

  return {
    query,
    target,
    maxPages: Math.max(1, Math.min(20, Math.floor(input.maxPages || 1))),
    browserCount: Math.max(1, Math.min(20, Math.floor(input.browserCount || 1))),
    proxyFilter: input.proxyFilter
  };
}
