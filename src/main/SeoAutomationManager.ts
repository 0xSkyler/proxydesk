import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import type { ProxyAssignment } from '../shared/types/proxy';
import type {
  SeoAutomationConfig,
  SeoAutomationResult,
  SeoAutomationState
} from '../shared/types/automation';
import { normalizeAutomationIntervalSeconds } from '../shared/types/automation';
import { normalizeTargetHost } from '../shared/seo';
import type { BrowserManager } from './BrowserManager';
import type { ProxyManager } from './ProxyManager';
import type { SettingsManager } from './SettingsManager';
import { logger } from './Logger';

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- standard Node EventEmitter typed-events pattern
export declare interface SeoAutomationManager {
  on(event: 'stateChanged', listener: (state: SeoAutomationState) => void): this;
  emit(event: 'stateChanged', state: SeoAutomationState): boolean;
  on(event: 'seoResult', listener: (payload: SeoAutomationResult) => void): this;
  emit(event: 'seoResult', payload: SeoAutomationResult): boolean;
}

/**
 * Session-only orchestration for:
 *   proxy file -> streaming validation -> immediate assignment -> Google SEO
 *   search -> target-result click -> enhanced Keep Alive.
 *
 * Configuration is intentionally kept only in memory so closing ProxyDesk
 * clears the selected path, query and runtime rotation state along with the
 * proxy pool.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- standard Node EventEmitter typed-events pattern
export class SeoAutomationManager extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  private pendingCycle = false;

  private state: SeoAutomationState = {
    running: false,
    cycleInProgress: false,
    sourceFilePath: null,
    query: '',
    targetWebsite: '',
    intervalSec: 600,
    browserIds: [],
    cycleNumber: 0,
    checkedProxies: 0,
    totalProxies: 0,
    liveProxies: 0,
    assignedBrowsers: 0
  };

  constructor(
    private readonly proxyManager: ProxyManager,
    private readonly browserManager: BrowserManager,
    private readonly settingsManager: SettingsManager,
    private readonly getActiveBrowserIds: () => number[]
  ) {
    super();
  }

  getState(): SeoAutomationState {
    return {
      ...this.state,
      browserIds: [...this.state.browserIds]
    };
  }

  isRunning(): boolean {
    return this.state.running;
  }

  async start(config: SeoAutomationConfig): Promise<SeoAutomationState> {
    const sourceFilePath = config.sourceFilePath.trim();
    const query = config.query.trim();
    const targetWebsite = config.targetWebsite.trim();

    if (!sourceFilePath) throw new Error('Select a proxy source file first.');
    await fs.access(sourceFilePath);

    if (!query) throw new Error('Enter a Google search keyword.');
    if (!normalizeTargetHost(targetWebsite)) throw new Error('Enter a valid target website or domain.');

    const active = new Set(this.getActiveBrowserIds());
    const browserIds = Array.from(new Set(config.browserIds))
      .filter((id) => active.has(id))
      .sort((a, b) => a - b);
    if (browserIds.length === 0) throw new Error('Select at least one active browser.');

    this.stopTimerOnly();
    this.proxyManager.cancelCurrentValidation();
    this.generation += 1;
    this.pendingCycle = false;

    const intervalSec = normalizeAutomationIntervalSeconds(config.intervalSec);
    this.state = {
      running: true,
      cycleInProgress: false,
      sourceFilePath,
      query,
      targetWebsite,
      intervalSec,
      browserIds,
      cycleNumber: 0,
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
        // Browser may have been removed while automation was running.
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
    if (!this.state.running) throw new Error('Start autonomous SEO rotation first.');
    await this.requestCycle();
    return this.getState();
  }

  private stopTimerOnly(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
    if (!this.state.running || !this.state.sourceFilePath) return;

    const generation = this.generation;
    const cycleNumber = this.state.cycleNumber + 1;
    const browserIds = [...this.state.browserIds];
    const sourceFilePath = this.state.sourceFilePath;
    const query = this.state.query;
    const targetWebsite = this.state.targetWebsite;

    this.state = {
      ...this.state,
      cycleInProgress: true,
      cycleNumber,
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
      // A new cycle must use only proxies read from the selected source file.
      // Stop Keep Alive and put selected browsers in direct mode until a
      // freshly validated working proxy is assigned.
      for (const id of browserIds) {
        if (!this.isCurrent(generation)) return;
        try {
          this.browserManager.setBrowserKeepAlive(id, false, false);
          await this.browserManager.assignProxy(id, null);
        } catch (err) {
          logger.warn('browser', `Automation cycle ${cycleNumber}: failed to reset Browser ${id}: ${(err as Error).message}`);
        }
      }

      const settings = this.settingsManager.get();

      await this.proxyManager.validateFileStreaming(
        sourceFilePath,
        browserIds,
        settings.proxy.preferredCountryCode,
        (assignment) => {
          if (!this.isCurrent(generation)) return;
          const task = this.handleAssignment(generation, cycleNumber, assignment, query, targetWebsite);
          seoTasks.push(task);
        },
        (checked, total, working, assigned) => {
          if (!this.isCurrent(generation)) return;
          this.state = {
            ...this.state,
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
        `Autonomous SEO cycle ${cycleNumber} complete: ${this.state.liveProxies} live proxies, ${this.state.assignedBrowsers} browser(s) assigned.`
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
      logger.warn('application', `Autonomous SEO cycle ${cycleNumber} failed: ${(err as Error).message}`);
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
    targetWebsite: string
  ): Promise<void> {
    if (!assignment.proxy || !this.isCurrent(generation)) return;

    const { browserId, proxy } = assignment;

    try {
      // Apply the live proxy immediately; do not wait for the rest of the
      // validation batch.
      await this.browserManager.assignProxy(browserId, proxy);
      if (!this.isCurrent(generation)) return;

      const result = await this.browserManager.broadcastSearch(
        browserId,
        query,
        targetWebsite,
        this.settingsManager.get().browser.seoMaxPages
      );

      if (!this.isCurrent(generation)) {
        try {
          this.browserManager.setBrowserKeepAlive(browserId, false, false);
        } catch {
          // Browser was removed while stopping.
        }
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
