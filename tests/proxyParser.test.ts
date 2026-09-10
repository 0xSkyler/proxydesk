import { describe, expect, it } from 'vitest';
import { ProxyParser, buildProxyId, dedupeProxies, parseBulkText, toProxyRecord } from '../src/proxy/ProxyParser';

describe('ProxyParser', () => {
  it('parses a plain http URL proxy', () => {
    const parsed = ProxyParser.parseLine('http://1.2.3.4:8080');
    expect(parsed).toEqual({ host: '1.2.3.4', port: 8080, protocol: 'http', username: undefined, password: undefined });
  });

  it('parses an authenticated proxy URL', () => {
    const parsed = ProxyParser.parseLine('http://user:pass@1.2.3.4:8080');
    expect(parsed.username).toBe('user');
    expect(parsed.password).toBe('pass');
    expect(parsed.host).toBe('1.2.3.4');
    expect(parsed.port).toBe(8080);
  });

  it('parses a SOCKS5 proxy URL', () => {
    const parsed = ProxyParser.parseLine('socks5://9.10.11.12:1080');
    expect(parsed.protocol).toBe('socks5');
    expect(parsed.port).toBe(1080);
  });

  it('parses host:port form', () => {
    const parsed = ProxyParser.parseLine('127.0.0.1:8080');
    expect(parsed).toMatchObject({ host: '127.0.0.1', port: 8080, protocol: 'http' });
  });

  it('parses host:port:username:password form', () => {
    const parsed = ProxyParser.parseLine('127.0.0.1:8080:username:password');
    expect(parsed).toMatchObject({
      host: '127.0.0.1',
      port: 8080,
      protocol: 'http',
      username: 'username',
      password: 'password'
    });
  });

  it('throws on garbage input via parseLine', () => {
    expect(() => ProxyParser.parseLine('garbage')).toThrow();
  });

  it('returns null on garbage input via tryParseLine (never throws)', () => {
    expect(ProxyParser.tryParseLine('garbage')).toBeNull();
    expect(ProxyParser.tryParseLine('not a proxy at all !!')).toBeNull();
    expect(ProxyParser.tryParseLine('')).toBeNull();
  });

  it('rejects invalid ports', () => {
    expect(ProxyParser.tryParseLine('1.2.3.4:99999')).toBeNull();
    expect(ProxyParser.tryParseLine('1.2.3.4:0')).toBeNull();
    expect(ProxyParser.tryParseLine('1.2.3.4:notaport')).toBeNull();
  });

  it('builds a stable, case-insensitive-host id', () => {
    const id1 = buildProxyId({ protocol: 'http', host: 'Example.com', port: 8080 });
    const id2 = buildProxyId({ protocol: 'http', host: 'example.com', port: 8080 });
    expect(id1).toBe(id2);
  });
});

describe('parseBulkText', () => {
  it('parses a multi-line block and never throws on malformed lines', () => {
    const text = [
      'http://1.2.3.4:8080',
      'garbage',
      'socks5://9.10.11.12:1080',
      '# a comment',
      '',
      '127.0.0.1:8080:user:pass'
    ].join('\n');

    const { proxies, invalidLines } = parseBulkText(text, 'test-source');
    expect(proxies).toHaveLength(3);
    expect(invalidLines).toEqual(['garbage']);
  });

  it('handles a fully empty import', () => {
    const { proxies, invalidLines } = parseBulkText('', 'test-source');
    expect(proxies).toHaveLength(0);
    expect(invalidLines).toHaveLength(0);
  });
});

describe('dedupeProxies', () => {
  it('merges duplicate protocol+host+port entries and preserves both sources', () => {
    const a = toProxyRecord({ host: '1.2.3.4', port: 8080, protocol: 'http' }, 'Provider A');
    const b = toProxyRecord({ host: '1.2.3.4', port: 8080, protocol: 'http' }, 'Provider B');
    const deduped = dedupeProxies([a, b]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].sources.sort()).toEqual(['Provider A', 'Provider B']);
  });

  it('keeps distinct proxies distinct', () => {
    const a = toProxyRecord({ host: '1.2.3.4', port: 8080, protocol: 'http' }, 'Provider A');
    const b = toProxyRecord({ host: '1.2.3.4', port: 8081, protocol: 'http' }, 'Provider A');
    expect(dedupeProxies([a, b])).toHaveLength(2);
  });
});
