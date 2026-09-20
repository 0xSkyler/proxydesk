import { describe, expect, it } from 'vitest';
import { normalizeAutomationIntervalSeconds } from '../src/shared/types/automation';

describe('autonomous SEO interval normalization', () => {
  it('uses 600 seconds for non-finite values', () => {
    expect(normalizeAutomationIntervalSeconds(Number.NaN)).toBe(600);
    expect(normalizeAutomationIntervalSeconds(Number.POSITIVE_INFINITY)).toBe(600);
  });

  it('clamps to a safe 5 second minimum and one day maximum', () => {
    expect(normalizeAutomationIntervalSeconds(1)).toBe(5);
    expect(normalizeAutomationIntervalSeconds(600)).toBe(600);
    expect(normalizeAutomationIntervalSeconds(999999)).toBe(86400);
  });

  it('floors fractional seconds', () => {
    expect(normalizeAutomationIntervalSeconds(600.9)).toBe(600);
  });
});
