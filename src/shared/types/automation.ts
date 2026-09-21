import type { BroadcastSearchResult } from './browser';

export interface SeoAutomationConfig {
  query: string;
  targetWebsite: string;
  /** How often a new ProxyScrape fetch + validation + proxy rotation begins. */
  intervalSec: number;
  /** Number of isolated browser workspaces, 1-100. */
  browserCount: number;
  /** Maximum Google result pages to inspect for each browser, 1-100. */
  maxPages: number;
}

export interface SeoAutomationState {
  running: boolean;
  cycleInProgress: boolean;
  proxySource: 'ProxyScrape Free API';
  query: string;
  targetWebsite: string;
  intervalSec: number;
  browserCount: number;
  maxPages: number;
  browserIds: number[];
  cycleNumber: number;
  fetchedProxies: number;
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
  return Math.max(30, Math.min(86_400, Math.floor(value)));
}

export function normalizeBrowserCount(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

export function normalizeSeoMaxPages(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(100, Math.floor(value)));
}
