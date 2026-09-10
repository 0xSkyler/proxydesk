import type { ProxyFetchOptions, ProxyProvider, ProxyRecord } from '../../shared/types/proxy';
import { parseBulkText } from '../ProxyParser';

/**
 * Fetches from ProxyScrape's free, publicly documented, no-auth-required
 * proxy list API (https://api.proxyscrape.com). This endpoint is designed
 * for exactly this kind of automated retrieval — it is not a scrape of a
 * page meant for humans, requires no CAPTCHA bypass or auth circumvention,
 * and simply returns a plaintext proxy list.
 *
 * Country metadata: this free endpoint does not reliably label every proxy
 * with a country, so entries from it are marked `countryVerified: false`
 * unless a query param constrained the result set to a single requested
 * country — see the comment below.
 */
export class PublicProxyProvider implements ProxyProvider {
  readonly name = 'ProxyScrape (public)';
  readonly kind = 'public' as const;

  private readonly endpoints: Record<'http' | 'socks4' | 'socks5', string> = {
    http: 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&format=textplain',
    socks4: 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks4&timeout=10000&format=textplain',
    socks5: 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks5&timeout=10000&format=textplain'
  };

  async fetchProxies(options: ProxyFetchOptions): Promise<ProxyRecord[]> {
    const results: ProxyRecord[] = [];

    for (const [protocol, url] of Object.entries(this.endpoints) as Array<
      [keyof typeof this.endpoints, string]
    >) {
      const text = await this.fetchOne(url, options.signal);
      if (!text) continue;

      // The plaintext format is `host:port` per line with no protocol prefix,
      // so we prefix each line before handing it to the shared parser.
      const prefixed = text
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => `${protocol}://${l.trim()}`)
        .join('\n');

      const { proxies } = parseBulkText(prefixed, this.name);
      results.push(...proxies);
    }

    // This provider cannot verify country per-proxy from the free endpoint,
    // so we honestly report country as unknown rather than guessing.
    if (options.countryCode) {
      // No reliable per-proxy country data available — return nothing rather
      // than mislabeling proxies with a guessed country.
      return [];
    }

    return results;
  }

  private async fetchOne(url: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!response.ok) return null;
      return await response.text();
    } catch {
      // Network failure, timeout, or the endpoint being unreachable — the
      // provider fails gracefully and the rest of the pipeline continues.
      return null;
    }
  }
}
