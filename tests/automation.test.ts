import { describe, expect, it } from 'vitest';
import {
  normalizeAutomationIntervalSeconds,
  normalizeBrowserCount,
  normalizeSeoMaxPages
} from '../src/shared/types/automation';
import { BROWSER_IDS } from '../src/shared/types/browser';

describe('SEO Tracker normalization', () => {
  it('normalizes rotation interval', () => {
    expect(normalizeAutomationIntervalSeconds(Number.NaN)).toBe(600);
    expect(normalizeAutomationIntervalSeconds(1)).toBe(30);
    expect(normalizeAutomationIntervalSeconds(600.9)).toBe(600);
    expect(normalizeAutomationIntervalSeconds(999999)).toBe(86400);
  });

  it('allows 1-100 browsers', () => {
    expect(normalizeBrowserCount(0)).toBe(1);
    expect(normalizeBrowserCount(10)).toBe(10);
    expect(normalizeBrowserCount(101)).toBe(100);
    expect(BROWSER_IDS).toHaveLength(100);
    expect(new Set(BROWSER_IDS).size).toBe(100);
  });

  it('allows scanning 1-100 Google result pages', () => {
    expect(normalizeSeoMaxPages(0)).toBe(1);
    expect(normalizeSeoMaxPages(20)).toBe(20);
    expect(normalizeSeoMaxPages(500)).toBe(100);
  });
});
