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
 * -> continuous Google monitoring -> challenge pause/resume
 * -> exact-host result click -> repeating same-host Keep Alive
 * -> rotate and restart on the user-configured cadence.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
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
    const targetHost = normalizeTargetHost(targetWebsite);
    const requestedInteractionHost = normalizeTargetHost(config.controlledTestHost ?? '');
    if (!query) throw new Error('Enter a Google search keyword.');
    if (!targetHost) throw new Error('Enter a valid target website or site name.');

    // Target website is the interaction host by default. An explicit override
    // is allowed only when it resolves to the exact same hostname, so result
    // opening and Keep Alive can never drift to a different site.
    const controlledTestHost = requestedInteractionHost || targetHost;
    if (controlledTestHost !== targetHost) {
      throw new Error('Interaction host must exactly match the Target website host.');
    }

    const browserCount = normalizeBrowserCount(config.browserCount);
    const maxPages = normalizeSeoMaxPages(config.maxPages);
    const intervalSec = normalizeAutomationIntervalSeconds(config.intervalSec);

    this.stopTimerOnly();
    this.proxyManager.cancelCurrentValidation();
    this.proxyManager.resetRotationHistory();
    this.generation += 1;
    this.pendingCycle = false;

    // Publish state before any browser preparation. The Start button therefore
    // reacts instantly even if Electron still has browser shells to create.
    this.state = {
      running: true,
      cycleInProgress: true,
      proxySource: 'ProxyScrape Free API',
      query,
      targetWebsite,
      controlledTestHost: controlledTestHost || undefined,
      intervalSec,
      browserCount,
      maxPages,
      browserIds: [],
      cycleNumber: 0,
      fetchedProxies: 0,
      checkedProxies: 0,
      totalProxies: 0,
      liveProxies: 0,
      assignedBrowsers: 0,
      nextCycleAt: new Date(Date.now() + intervalSec * 1000).toISOString()
    };
    this.emitState();

    let browserIds: number[];
    try {
      browserIds = await this.ensureBrowserCount(browserCount);
    } catch (err) {
      this.state = {
        ...this.state,
        running: false,
        cycleInProgress: false,
        nextCycleAt: undefined,
        lastError: `Browser preparation failed: ${(err as Error).message}`
      };
      this.emitState();
      throw err;
    }

    if (browserIds.length === 0) {
      this.state = {
        ...this.state,
        running: false,
        cycleInProgress: false,
        nextCycleAt: undefined,
        lastError: 'No browser workspaces are available.'
      };
      this.emitState();
      throw new Error('No browser workspaces are available.');
    }

    this.state = {
      ...this.state,
      cycleInProgress: false,
      browserIds
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
        this.browserManager.cancelMeasurementSession(id);
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
    const { query, targetWebsite, controlledTestHost, maxPages } = this.state;

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
        this.browserManager.cancelMeasurementSession(id);
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
              controlledTestHost,
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
    controlledTestHost: string | undefined,
    maxPages: number
  ): Promise<void> {
    if (!assignment.proxy || !this.isCurrent(generation)) return;

    const { browserId, proxy } = assignment;
    try {
      await this.browserManager.assignProxy(browserId, proxy);
      if (!this.isCurrent(generation)) return;

      this.browserManager.setBrowserKeepAlive(browserId, false, false);
      const measurementToken = this.browserManager.startMeasurementSession(browserId);

      // Run the measurement loop independently of proxy validation. Each
      // browser keeps observing for the lifetime of this proxy cycle and is
      // invalidated as soon as the next rotation begins.
      void this.monitorBrowserSession(
        generation,
        cycleNumber,
        browserId,
        measurementToken,
        query,
        targetWebsite,
        controlledTestHost,
        maxPages
      );
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

  private async monitorBrowserSession(
    generation: number,
    cycleNumber: number,
    browserId: number,
    measurementToken: number,
    query: string,
    targetWebsite: string,
    controlledTestHost: string | undefined,
    maxPages: number
  ): Promise<void> {
    const observationIntervalMs = 30_000;
    const interactionHost = controlledTestHost || normalizeTargetHost(targetWebsite);
    if (!interactionHost) return;

    while (
      this.isCurrent(generation) &&
      this.state.cycleNumber === cycleNumber &&
      this.browserManager.isMeasurementSessionCurrent(browserId, measurementToken)
    ) {
      let result;
      try {
        result = await this.browserManager.broadcastSearch(
          browserId,
          query,
          targetWebsite,
          maxPages,
          measurementToken
        );
      } catch (err) {
        if (
          !this.isCurrent(generation) ||
          this.state.cycleNumber !== cycleNumber ||
          !this.browserManager.isMeasurementSessionCurrent(browserId, measurementToken)
        ) {
          return;
        }

        this.emit('seoResult', {
          cycleNumber,
          result: {
            browserId,
            status: 'error',
            error: (err as Error).message,
            monitoring: true,
            ranAt: new Date().toISOString()
          }
        });
        await sleep(5_000);
        continue;
      }

      if (
        !this.isCurrent(generation) ||
        this.state.cycleNumber !== cycleNumber ||
        !this.browserManager.isMeasurementSessionCurrent(browserId, measurementToken)
      ) {
        return;
      }

      if (
        result.status === 'matched' &&
        result.interactionStatus === 'opened' &&
        result.matchedUrl
      ) {
        this.browserManager.startControlledKeepAlive(browserId, interactionHost);
        this.emit('seoResult', {
          cycleNumber,
          result: {
            ...result,
            keepAliveStarted: true
          }
        });
        return;
      }

      if (
        result.status === 'matched' &&
        result.interactionStatus === 'click-failed'
      ) {
        this.emit('seoResult', { cycleNumber, result });
        await sleep(3_000);
        continue;
      }

      if (result.status === 'matched' && result.matchedUrl) {
        let matchedHost = '';
        try {
          matchedHost = new URL(result.matchedUrl).hostname
            .toLowerCase()
            .replace(/^www\./, '')
            .replace(/\.$/, '');
        } catch {
          matchedHost = '';
        }

        if (matchedHost !== interactionHost) {
          this.emit('seoResult', {
            cycleNumber,
            result: {
              ...result,
              interactionStatus: 'click-failed',
              error: `Matched result host ${matchedHost || 'unknown'} does not equal configured interaction host ${interactionHost}.`
            }
          });
          await sleep(3_000);
          continue;
        }

        this.emit('seoResult', {
          cycleNumber,
          result: {
            ...result,
            interactionStatus: 'opening'
          }
        });

        const clicked = await this.browserManager.clickControlledGoogleResult(
          browserId,
          query,
          interactionHost,
          result.matchedUrl,
          measurementToken
        );

        if (clicked) {
          this.browserManager.startControlledKeepAlive(browserId, interactionHost);
          this.emit('seoResult', {
            cycleNumber,
            result: {
              ...result,
              landedUrl: result.matchedUrl,
              interactionStatus: 'opened',
              keepAliveStarted: true
            }
          });
          return;
        }

        this.emit('seoResult', {
          cycleNumber,
          result: {
            ...result,
            interactionStatus: 'click-failed',
            error: 'Target was detected, but the result could not be opened. ProxyDesk will retry in this session.'
          }
        });
        await sleep(3_000);
        continue;
      }

      this.emit('seoResult', { cycleNumber, result });

      if (result.status === 'paused') {
        // Keep the same browser, proxy, cookies, and Google session. We do not
        // solve or bypass the challenge; we simply wait for normal results to
        // return, then resume the saved keyword/website measurement.
        const recovered = await this.browserManager.waitForGoogleRecovery(
          browserId,
          observationIntervalMs
        );

        if (!recovered) {
          await sleep(1_000);
        }
        continue;
      }

      // Matched and no-match observations are measurements, not terminal
      // states. Recheck periodically until the next proxy rotation.
      await sleep(observationIntervalMs);
    }
  }

  private isCurrent(generation: number): boolean {
    return this.state.running && generation === this.generation;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
