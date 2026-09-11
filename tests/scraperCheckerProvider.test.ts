import { describe, expect, it } from 'vitest';
import { extractProxies } from '../src/proxy/providers/ScraperCheckerProvider';

describe('ScraperCheckerProvider extractProxies', () => {
  it('extracts plain host:port lines', () => {
    const text = '1.2.3.4:8080\n5.6.7.8:1080\n';
    const found = extractProxies(text, 'http', 'test');
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ host: '1.2.3.4', port: 8080, protocol: 'http' });
    expect(found[1]).toMatchObject({ host: '5.6.7.8', port: 1080, protocol: 'http' });
  });

  it('extracts proxies from messy trailing text (spys.me style)', () => {
    const text = '1.2.3.4:8080 RU-H!\n5.6.7.8:1080 US-N!\n';
    const found = extractProxies(text, 'socks5', 'test');
    expect(found).toHaveLength(2);
  });

  it('extracts proxies embedded in JSON', () => {
    const text = '["1.2.3.4:8080","5.6.7.8:1080"]';
    const found = extractProxies(text, 'http', 'test');
    expect(found).toHaveLength(2);
  });

  it('extracts proxies embedded in HTML', () => {
    const text = '<tr><td>1.2.3.4</td><td>8080</td></tr>'; // won't pair split cells
    const found = extractProxies(text, 'http', 'test');
    // Split table cells can't be paired by this generic regex — expect 0,
    // not a false pairing. This documents the known limitation rather than
    // silently asserting incorrect behavior.
    expect(found).toHaveLength(0);
  });

  it('rejects invalid octets', () => {
    const text = '999.999.999.999:8080\n1.2.3.4:8080\n';
    const found = extractProxies(text, 'http', 'test');
    expect(found).toHaveLength(1);
    expect(found[0].host).toBe('1.2.3.4');
  });

  it('rejects ports out of range', () => {
    const text = '1.2.3.4:70000\n1.2.3.4:8080\n';
    const found = extractProxies(text, 'http', 'test');
    expect(found).toHaveLength(1);
    expect(found[0].port).toBe(8080);
  });

  it('dedupes repeated entries within one source', () => {
    const text = '1.2.3.4:8080\n1.2.3.4:8080\n1.2.3.4:8080\n';
    const found = extractProxies(text, 'http', 'test');
    expect(found).toHaveLength(1);
  });

  it('tags every extracted proxy with the given protocol and source', () => {
    const found = extractProxies('1.2.3.4:8080', 'socks4', 'Aggregated Public Lists');
    expect(found[0].protocol).toBe('socks4');
    expect(found[0].sources).toEqual(['Aggregated Public Lists']);
    expect(found[0].id).toBe('socks4://1.2.3.4:8080');
  });
});
