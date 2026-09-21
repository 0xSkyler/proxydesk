import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserView: class {},
  BrowserWindow: class {}
}));

import { parseProxyScrapeText } from '../src/main/ProxyScrapeService';
import {
  buildGoogleScanScript,
  buildGoogleSearchUrl,
  normalizeTarget
} from '../src/main/SeoBrowserManager';

describe('ProxyScrape parser', () => {
  it('parses supported protocols and removes duplicates', () => {
    const proxies = parseProxyScrapeText([
      'http://1.2.3.4:80',
      'socks5://5.6.7.8:1080',
      'https://9.9.9.9:443',
      'http://1.2.3.4:80',
      'invalid',
      ''
    ].join('\n'));

    expect(proxies).toHaveLength(3);
    expect(proxies.map((proxy) => proxy.protocol)).toEqual(['http', 'socks5', 'https']);
    expect(proxies[0]).toMatchObject({ host: '1.2.3.4', port: 80 });
  });
});

describe('Google page helpers', () => {
  it('builds sequential result pages without pinning search to page one', () => {
    expect(buildGoogleSearchUrl('rmg cutting', 0)).not.toContain('start=');
    expect(buildGoogleSearchUrl('rmg cutting', 1)).toContain('start=10');
    expect(buildGoogleSearchUrl('rmg cutting', 4)).toContain('start=40');
  });

  it('normalizes a full URL or a bare site name', () => {
    expect(normalizeTarget('https://www.appareldiary.com/article/test')).toBe('appareldiary.com');
    expect(normalizeTarget('appareldiary')).toBe('appareldiary');
  });

  it('finds the target among rendered organic results and schedules its Google result click', () => {
    const clickTarget = vi.fn();

    function makeAnchor(url: string, title: string, click = vi.fn()) {
      const heading = { innerText: title };
      const card = { innerText: title + '\n' + url };
      return {
        href: url,
        innerText: title,
        target: '',
        getAttribute: (name: string) => (name === 'href' ? url : null),
        querySelector: (selector: string) => (selector === 'h3' ? heading : null),
        closest: () => card,
        parentElement: card,
        scrollIntoView: vi.fn(),
        click
      };
    }

    const competitor = makeAnchor('https://example.com/other', 'Example result');
    const target = makeAnchor(
      'https://appareldiary.com/article/rmg-cutting',
      'RMG Cutting Process: A Stage-by-Stage Control Guide',
      clickTarget
    );

    const root = {
      querySelectorAll: (selector: string) => (selector === 'a[href]' ? [competitor, target] : [])
    };
    const document = {
      body: { innerText: 'Google search results' },
      querySelector: (selector: string) => (selector === '#search' ? root : null)
    };
    const location = { href: 'https://www.google.com/search?q=rmg+cutting' };

    const result = vm.runInNewContext(buildGoogleScanScript('appareldiary.com'), {
      document,
      location,
      URL,
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      }
    }) as {
      blocked: boolean;
      resultsCount: number;
      match?: { url: string; title: string; organicIndex: number };
    };

    expect(result.blocked).toBe(false);
    expect(result.resultsCount).toBe(2);
    expect(result.match?.url).toBe('https://appareldiary.com/article/rmg-cutting');
    expect(result.match?.organicIndex).toBe(1);
    expect(clickTarget).toHaveBeenCalledTimes(1);
  });

  it('reports a Google challenge rather than trying to bypass it', () => {
    const result = vm.runInNewContext(buildGoogleScanScript('appareldiary.com'), {
      document: {
        body: { innerText: 'Our systems have detected unusual traffic. Please verify you are not a robot.' },
        querySelector: () => null
      },
      location: { href: 'https://www.google.com/sorry/index' },
      URL,
      setTimeout
    }) as { blocked: boolean; resultsCount: number };

    expect(result.blocked).toBe(true);
    expect(result.resultsCount).toBe(0);
  });
});
