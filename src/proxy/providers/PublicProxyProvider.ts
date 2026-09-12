import type { ProxyFetchOptions, ProxyProvider, ProxyRecord } from '../../shared/types/proxy';
import { parseBulkText } from '../ProxyParser';

/**
 * Fetches from ProxyScrape's free, publicly documented, no-auth-required
 * proxy list API (https://api.proxyscrape.com). This endpoint is designed
 * for exactly this kind of automated retrieval — it is not a scrape of a
 * page meant for humans, requires no CAPTCHA bypass or auth circumvention,
 * and simply returns a plaintext proxy list.
 *
 * Country metadata: results are only marked `countryVerified: true` when a
 * country was requested and the API's own `country` filter constrained the
 * result set to it server-side; an unfiltered ("any country") fetch is
 * marked unverified since this endpoint doesn't reliably self-report it.
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
    const failures: string[] = [];

    for (const [protocol, url] of Object.entries(this.endpoints) as Array<
      [keyof typeof this.endpoints, string]
    >) {
      // ProxyScrape's v2 API accepts a `country` query param (ISO 3166-1
      // alpha-2, matching the codes in shared/constants/countries.ts) and
      // returns only proxies it has actually geo-tagged as that country —
      // so when the user picked a country, ask the API to filter server
      // side instead of fetching the unfiltered list and then discarding
      // it. (Previously this always returned [] whenever a country was
      // selected, "to avoid mislabeling" — but that made every country
      // selection a guaranteed dead end for this provider, which is why
      // reload kept finding 0 proxies no matter what was picked.)
      const requestUrl = options.countryCode
        ? `${url}&country=${options.countryCode.toLowerCase()}`
        : url;

      const outcome = await this.fetchOne(requestUrl, options.signal);
      if (outcome.error) {
        failures.push(`${protocol}: ${outcome.error}`);
        continue;
      }
      const text = outcome.text;
      if (!text) continue;

      // The plaintext format is `host:port` per line with no protocol prefix,
      // so we prefix each line before handing it to the shared parser.
      const prefixed = text
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => `${protocol}://${l.trim()}`)
        .join('\n');

      const { proxies } = parseBulkText(prefixed, this.name);

      // When the API filtered by country for us, that's a source we trust —
      // mark it verified rather than leaving it as unknown.
      if (options.countryCode) {
        for (const p of proxies) {
          p.countryCode = options.countryCode;
          p.countryVerified = true;
        }
      }

      results.push(...proxies);
    }

    // If every endpoint failed outright (network error, timeout, blocked,
    // rate-limited, etc.) that is a real problem worth surfacing as a
    // provider error rather than a silent "0 proxies found" that looks
    // identical to the endpoints simply having nothing to return. A partial
    // failure (some endpoints ok, some not) stays silent — the pipeline
    // already continues with whatever succeeded.
    if (failures.length === Object.keys(this.endpoints).length) {
      throw new Error(`All endpoints unreachable (${failures.join('; ')})`);
    }

    return results;
  }

  private async fetchOne(url: string, signal?: AbortSignal): Promise<{ text: string | null; error?: string }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return { text: null, error: `HTTP ${response.status}` };
        // The abort timer must stay armed through the body read, not just
        // until headers arrive — clearing it right after fetch() resolves
        // (as this used to do) left response.text() with no timeout at
        // all, so a source that answers with headers promptly but then
        // stalls or trickles its body could hang this fetch forever, which
        // hangs the whole provider's Promise.all, which hangs the whole
        // reload — including proxies that had nothing to do with this
        // provider, like imported ones, since reload() awaits every
        // provider before doing anything else.
        return { text: await response.text() };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Network failure, timeout, or the endpoint being unreachable.
      return { text: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
