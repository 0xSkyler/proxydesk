import { describe, expect, it } from 'vitest';
import { extractGoogleBlockContinueUrl } from '../src/main/BrowserManager';

describe('extractGoogleBlockContinueUrl', () => {
  it('extracts the continue= target from a Google CAPTCHA interstitial URL', () => {
    const blocked =
      'https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dapparel%2520diary%26num%3D20&hl=en';
    expect(extractGoogleBlockContinueUrl(blocked)).toBe('https://www.google.com/search?q=apparel%20diary&num=20');
  });

  it('falls back to the interstitial URL itself when there is no continue param', () => {
    const blocked = 'https://www.google.com/sorry/index?hl=en';
    expect(extractGoogleBlockContinueUrl(blocked)).toBe(blocked);
  });

  it('matches other Google TLDs, not just .com', () => {
    const blocked = 'https://www.google.co.uk/sorry/index?continue=https://www.google.co.uk/search%3Fq%3Dtest';
    expect(extractGoogleBlockContinueUrl(blocked)).toBe('https://www.google.co.uk/search?q=test');
  });

  it('returns null for a normal Google search results page', () => {
    expect(extractGoogleBlockContinueUrl('https://www.google.com/search?q=hello')).toBeNull();
  });

  it('returns null for a non-Google URL, even one with /sorry/ in the path', () => {
    expect(extractGoogleBlockContinueUrl('https://example.com/sorry/index')).toBeNull();
  });

  it('returns null for a malformed URL instead of throwing', () => {
    expect(extractGoogleBlockContinueUrl('not a url')).toBeNull();
  });
});
