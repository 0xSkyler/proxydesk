import { EventEmitter } from 'node:events';
import type { ProxyAssignment } from '../shared/types/proxy';
import type {
  SeoAutomationConfig,
  SeoAutomationResult,
  SeoAutomationState
} from '../shared/types/automation';
import {
  normalizeAutomationIntervalSeconds,
  normalizeBrowserCount,
  normalizeSeoMaxPages
} from '../shared/types/automation';
import { normalizeTargetHost } from '../shared/seo';
import type { BrowserManager } from './BrowserManager';
import type { ProxyManager } from './ProxyManager';
import { logger } from './Logger';

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface SeoAutomationManager {
  on(event: 'stateChanged', listener: (state: SeoAutomationState) => void): this;
  emit(event: 'stateChanged', state: SeoAutomationState): boolean;
  on(event: 'seoResult', listener: (payload: SeoAutomationResult) => void): this;
  emit(event: 'seoResult', payload: SeoAutomationResult): boolean;
}

/**
 * Single-purpose SEO Tracker orchestration:
 *
 * ProxyScrape free API -> local validation -> immediate exclusive assignment
 * -> Google result-page scan -> matched result click -> Keep Alive
 * -> rotate and repeat on the user-configured cadence.
 */
export class SeoAutomationManager extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  private pendingCycle = false;

  private state: SeoAutomationState = {
    running: false,
    cycleInProgress: false,
    proxySource: 'ProxyScrape Free API',
    query: '',
    targetWebsite: '',
    intervalSec: 600,
    browserCount: 10,
    maxPages: 20,
    browserIds: [],
    cycleNumber: 0,
    fetchedProxies: 0,
    checkedProxies: 0,
    totalProxies: 0,
    liveProxies: 0,
    assignedBrowsers: 0
  };

  constructor(
    private readonly proxyManager: ProxyManager,
    private readonly browserManager: BrowserManager,
    private readonly ensureBrowserCount: (count: number) => Promise<number[]>
  ) {
    super();
  }

  getState(): SeoAutomationState {
    return { ...this.state, browserIds: [...this.state.browserIds] };
  }

  isRunning(): boolean {
    return this.state.running;
  }

  async start(config: SeoAutomationConfig): Promise<SeoAutomationState> {
    const query = config.query.trim();
    const targetWebsite = config.targetWebsite.trim();
    if (!query) throw new Error('Enter a Google search keyword.');
    if (!normalizeTargetHost(targetWebsite)) throw new Error('Enter a valid target website or site name.');

    const browserCount = normalizeBrowserCount(config.browserCount);
    const maxPages = normalizeSeoMaxPages(config.maxPages);
    const intervalSec = normalizeAutomationIntervalSeconds(config.intervalSec);
    const browserIds = await this.ensureBrowserCount(browserCount);
    if (browserIds.length === 0) throw new Error('No browser workspaces are available.');

    this.stopTimerOnly();
    this.proxyManager.cancelCurrentValidation();
    this.proxyManager.resetRotationHistory();
    this.generation += 1;
    this.pendingCycle = false;

    this.state = {
      running: true,
      cycleInProgress: false,
      proxySource: 'ProxyScrape Free API',
      query,
      targetWebsite,
      intervalSec,
      browserCount,
      maxPages,
      browserIds,
      cycleNumber: 0,
      fetchedProxies: 0,
      checkedProxies: 0,
      totalProxies: 0,
      liveProxies: 0,
      assignedBrowsers: 0,
      nextCycleAt: new Date(Date.now() + intervalSec * 1000).toISOString()
    };
    this.emitState();

    this.timer = setInterval(() => {
      if (!this.state.running) return;
      this.state = {
        ...this.state,
        nextCycleAt: new Date(Date.now() + this.state.intervalSec * 1000).toISOString()
      };
      this.emitState();
      void this.requestCycle();
    }, intervalSec * 1000);

    void this.requestCycle();
    return this.getState();
  }

  stop(): SeoAutomationState {
    this.generation += 1;
    this.pendingCycle = false;
    this.proxyManager.cancelCurrentValidation();
    this.stopTimerOnly();

    for (const id of this.state.browserIds) {
      try {
        this.browserManager.setBrowserKeepAlive(id, false, false);
      } catch {
        // Browser may already have been removed.
      }
    }

    this.state = {
      ...this.state,
      running: false,
      cycleInProgress: false,
      nextCycleAt: undefined
    };
    this.emitState();
    return this.getState();
  }

  async runNow(): Promise<SeoAutomationState> {
    if (!this.state.running) throw new Error('Start SEO Tracker first.');
    await this.requestCycle();
    return this.getState();
  }

  private stopTimerOnly(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private emitState(): void {
    this.emit('stateChanged', this.getState());
  }

  private async requestCycle(): Promise<void> {
    if (!this.state.running) return;
    if (this.state.cycleInProgress) {
      this.pendingCycle = true;
      return;
    }
    await this.runCycle();
  }

  private async runCycle(): Promise<void> {
    if (!this.state.running) return;

    const generation = this.generation;
    const cycleNumber = this.state.cycleNumber + 1;
    const browserIds = [...this.state.browserIds];
    const { query, targetWebsite, maxPages } = this.state;

    this.state = {
      ...this.state,
      cycleInProgress: true,
      cycleNumber,
      fetchedProxies: 0,
      checkedProxies: 0,
      totalProxies: 0,
      liveProxies: 0,
      assignedBrowsers: 0,
      lastCycleStartedAt: new Date().toISOString(),
      lastError: undefined
    };
    this.emitState();

    const seoTasks: Promise<void>[] = [];

    try {
      // Every rotation starts from a clean browser routing state.
      for (const id of browserIds) {
        if (!this.isCurrent(generation)) return;
        this.browserManager.setBrowserKeepAlive(id, false, false);
        await this.browserManager.assignProxy(id, null);
      }

      await this.proxyManager.fetchValidateAssignStreaming(
        browserIds,
        (assignment) => {
          if (!this.isCurrent(generation)) return;
          seoTasks.push(
            this.handleAssignment(
              generation,
              cycleNumber,
              assignment,
              query,
              targetWebsite,
              maxPages
            )
          );
        },
        (checked, total, working, assigned, fetched) => {
          if (!this.isCurrent(generation)) return;
          this.state = {
            ...this.state,
            fetchedProxies: fetched,
            checkedProxies: checked,
            totalProxies: total,
            liveProxies: working,
            assignedBrowsers: assigned
          };
          this.emitState();
        }
      );

      await Promise.allSettled(seoTasks);

      if (!this.isCurrent(generation)) return;
      this.state = {
        ...this.state,
        cycleInProgress: false,
        lastCycleCompletedAt: new Date().toISOString()
      };
      this.emitState();

      logger.info(
        'application',
        `SEO cycle ${cycleNumber} complete: ${this.state.liveProxies} live, ` +
          `${this.state.assignedBrowsers}/${browserIds.length} browser(s) assigned.`
      );
    } catch (err) {
      if (!this.isCurrent(generation)) return;
      this.state = {
        ...this.state,
        cycleInProgress: false,
        lastCycleCompletedAt: new Date().toISOString(),
        lastError: (err as Error).message
      };
      this.emitState();
      logger.warn('application', `SEO cycle ${cycleNumber} failed: ${(err as Error).message}`);
    } finally {
      if (this.isCurrent(generation) && this.pendingCycle) {
        this.pendingCycle = false;
        void this.requestCycle();
      }
    }
  }

  private async handleAssignment(
    generation: number,
    cycleNumber: number,
    assignment: ProxyAssignment,
    query: string,
    targetWebsite: string,
    maxPages: number
  ): Promise<void> {
    if (!assignment.proxy || !this.isCurrent(generation)) return;

    const { browserId, proxy } = assignment;
    try {
      await this.browserManager.assignProxy(browserId, proxy);
      if (!this.isCurrent(generation)) return;

      const result = await this.browserManager.broadcastSearch(
        browserId,
        query,
        targetWebsite,
        maxPages
      );

      if (!this.isCurrent(generation)) {
        this.browserManager.setBrowserKeepAlive(browserId, false, false);
        return;
      }

      if (result.status !== 'matched') {
        this.browserManager.setBrowserKeepAlive(browserId, false, false);
      }

      this.emit('seoResult', { cycleNumber, result });
    } catch (err) {
      if (!this.isCurrent(generation)) return;
      this.browserManager.setBrowserKeepAlive(browserId, false, false);
      this.emit('seoResult', {
        cycleNumber,
        result: {
          browserId,
          status: 'error',
          error: (err as Error).message,
          ranAt: new Date().toISOString()
        }
      });
    }
  }

  private isCurrent(generation: number): boolean {
    return this.state.running && generation === this.generation;
  }
}
