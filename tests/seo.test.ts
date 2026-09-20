import { describe, expect, it } from 'vitest';
import { buildGoogleSearchUrl, hostMatchesTarget, normalizeTargetHost } from '../src/shared/seo';

describe('SEO helpers', () => {
  it('normalizes URLs and plain domains', () => {
    expect(normalizeTargetHost('https://www.ApparelDiary.com/article?a=1')).toBe('appareldiary.com');
    expect(normalizeTargetHost('appareldiary.com')).toBe('appareldiary.com');
  });

  it('matches exact hosts and subdomains without substring false positives', () => {
    expect(hostMatchesTarget('https://appareldiary.com/article/test', 'appareldiary.com')).toBe(true);
    expect(hostMatchesTarget('https://www.appareldiary.com/article/test', 'appareldiary.com')).toBe(true);
    expect(hostMatchesTarget('https://news.appareldiary.com/story', 'appareldiary.com')).toBe(true);
    expect(hostMatchesTarget('https://notappareldiary.com/story', 'appareldiary.com')).toBe(false);
  });

  it('builds paged Google URLs', () => {
    expect(buildGoogleSearchUrl('inventory safety stock', 0)).toContain('q=inventory+safety+stock');
    expect(buildGoogleSearchUrl('inventory safety stock', 2)).toContain('start=20');
  });
});
