import type { BroadcastSearchResult } from './browser';

export interface SeoAutomationConfig {
  sourceFilePath: string;
  query: string;
  targetWebsite: string;
  /** Cycle cadence in seconds. Default UI value is 600 (10 minutes). */
  intervalSec: number;
  /** Browser workspaces included in the autonomous workflow. */
  browserIds: number[];
}

export interface SeoAutomationState {
  running: boolean;
  cycleInProgress: boolean;
  sourceFilePath: string | null;
  query: string;
  targetWebsite: string;
  intervalSec: number;
  browserIds: number[];
  cycleNumber: number;
  checkedProxies: number;
  totalProxies: number;
  liveProxies: number;
  assignedBrowsers: number;
  lastCycleStartedAt?: string;
  lastCycleCompletedAt?: string;
  nextCycleAt?: string;
  lastError?: string;
}

export interface SeoAutomationResult {
  cycleNumber: number;
  result: BroadcastSearchResult;
}

export function normalizeAutomationIntervalSeconds(value: number): number {
  if (!Number.isFinite(value)) return 600;
  return Math.max(5, Math.min(86_400, Math.floor(value)));
}
