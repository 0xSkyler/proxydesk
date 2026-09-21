import type { ProxyEndpoint, ProxyFetchSummary, ProxyFilter, ProxyProtocol } from '../shared/tracker';

const API_URL =
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text';

const PROTOCOLS = new Set<ProxyProtocol>(['http', 'https', 'socks4', 'socks5']);

export class ProxyScrapeService {
  private proxies: ProxyEndpoint[] = [];

  async refresh(): Promise<ProxyFetchSummary> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);

    try {
      const response = await fetch(API_URL, {
        signal: controller.signal,
        headers: {
          accept: 'text/plain',
          'user-agent': 'ProxyDesk-SEO-Tracker/0.4'
        }
      });
      if (!response.ok) {
        throw new Error(`ProxyScrape returned HTTP ${response.status}`);
      }

      const text = await response.text();
      this.proxies = parseProxyScrapeText(text);
      if (this.proxies.length === 0) {
        throw new Error('ProxyScrape returned no usable public proxies.');
      }

      const protocols: Record<ProxyProtocol, number> = {
        http: 0,
        https: 0,
        socks4: 0,
        socks5: 0
      };
      for (const proxy of this.proxies) protocols[proxy.protocol] += 1;

      return {
        fetched: this.proxies.length,
        protocols,
        fetchedAt: new Date().toISOString()
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async get(filter: ProxyFilter): Promise<ProxyEndpoint[]> {
    if (this.proxies.length === 0) await this.refresh();
    if (filter === 'all') return [...this.proxies];
    return this.proxies.filter((proxy) => proxy.protocol === filter);
  }
}

export function parseProxyScrapeText(text: string): ProxyEndpoint[] {
  const seen = new Set<string>();
  const proxies: ProxyEndpoint[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:(http|https|socks4|socks5):\/\/)?(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/i);
    if (!match) continue;

    const protocol = (match[1] ?? 'http').toLowerCase() as ProxyProtocol;
    if (!PROTOCOLS.has(protocol)) continue;

    const host = match[2].replace(/^\[|\]$/g, '').trim();
    const port = Number(match[3]);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;

    const id = `${protocol}://${host}:${port}`;
    if (seen.has(id)) continue;
    seen.add(id);
    proxies.push({ id, protocol, host, port });
  }

  return proxies;
}
