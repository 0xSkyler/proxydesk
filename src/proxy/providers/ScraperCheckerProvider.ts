import type { ProxyFetchOptions, ProxyProtocol, ProxyProvider, ProxyRecord } from '../../shared/types/proxy';
import { toProxyRecord } from '../ProxyParser';

/**
 * Aggregates the same public proxy-list sources used by
 * https://github.com/monosans/proxy-scraper-checker (that project is a
 * standalone Python/Rust CLI — this port reuses its curated source list and
 * its "extract host:port from whatever format the source returns" approach,
 * adapted to this app's existing ProxyProvider/ProxyRecord pipeline rather
 * than shelling out to a separate tool).
 *
 * Each source is a plain URL that returns some kind of list of proxies —
 * usually one `host:port` per line, but a few are JSON or an HTML page.
 * Rather than writing a bespoke parser per source (most of which can change
 * format without notice), every response is scanned with one generic
 * IPv4:port regex, the same "extract proxies from any format" idea the
 * original tool documents. This is deliberately restricted to bare IPv4
 * addresses (not hostnames) to avoid false positives from unrelated
 * digit-and-colon text a page or JSON file might contain elsewhere.
 *
 * These sources carry no country metadata, so results are only usable when
 * "Any Country" is selected — ProxyManager's filterByCountry drops any
 * proxy without a matching countryCode once a specific country is chosen
 * (see PublicProxyProvider for the one source that *can* filter by country
 * via its own API).
 */
export class ScraperCheckerProvider implements ProxyProvider {
  readonly name = 'Aggregated Public Lists';
  readonly kind = 'public' as const;

  private static readonly FETCH_TIMEOUT_MS = 10000;
  private static readonly MAX_CONCURRENT_FETCHES = 12;
  private static readonly MAX_PER_SOURCE = 150;

  private static readonly SOURCES: ReadonlyArray<{ url: string; protocol: ProxyProtocol }> = [
    // --- HTTP / HTTPS ---
    { url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http', protocol: 'http' },
    { url: 'https://api.proxyscrape.com/v3/free-proxy-list/get?request=getproxies&protocol=http', protocol: 'http' },
    { url: 'https://api.proxyscrape.com/v3/free-proxy-list/get?request=getproxies&protocol=https', protocol: 'https' },
    {
      url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text',
      protocol: 'http'
    },
    { url: 'https://openproxylist.xyz/http.txt', protocol: 'http' },
    { url: 'https://openproxylist.xyz/https.txt', protocol: 'https' },
    {
      url: 'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/refs/heads/main/proxy_files/http_proxies.txt',
      protocol: 'http'
    },
    { url: 'https://raw.githubusercontent.com/ObcbO/getproxy/refs/heads/master/file/http.txt', protocol: 'http' },
    { url: 'https://raw.githubusercontent.com/ObcbO/getproxy/refs/heads/master/file/https.txt', protocol: 'https' },
    { url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/refs/heads/master/http.txt', protocol: 'http' },
    { url: 'https://raw.githubusercontent.com/TuanMinPay/live-proxy/refs/heads/master/http.txt', protocol: 'http' },
    {
      url: 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/refs/heads/master/http.txt',
      protocol: 'http'
    },
    {
      url: 'https://raw.githubusercontent.com/dinoz0rg/proxy-list/refs/heads/main/checked_proxies/http.txt',
      protocol: 'http'
    },
    { url: 'https://raw.githubusercontent.com/dpangestuw/Free-PROXY/refs/heads/main/http_proxies.txt', protocol: 'http' },
    {
      url: 'https://raw.githubusercontent.com/ebrasha/abdal-proxy-hub/refs/heads/main/http-proxy-list-by-EbraSha.txt',
      protocol: 'http'
    },
    {
      url: 'https://raw.githubusercontent.com/ebrasha/abdal-proxy-hub/refs/heads/main/https-proxy-list-by-EbraSha.txt',
      protocol: 'https'
    },
    { url: 'https://raw.githubusercontent.com/hproxy-com/free-proxy-list/refs/heads/main/http.txt', protocol: 'http' },
    { url: 'https://raw.githubusercontent.com/hproxy-com/free-proxy-list/refs/heads/main/https.txt', protocol: 'https' },
    {
      url: 'https://raw.githubusercontent.com/iplocate/free-proxy-list/refs/heads/main/protocols/http.txt',
      protocol: 'http'
    },
    {
      url: 'https://raw.githubusercontent.com/mauricegift/free-proxies/refs/heads/master/files/http.json',
      protocol: 'http'
    },
    {
      url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/protocols/http/data.txt',
      protocol: 'http'
    },
    {
      url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/protocols/https/data.txt',
      protocol: 'https'
    },
    { url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/refs/heads/main/HTTPS_RAW.txt', protocol: 'https' },
    {
      url: 'https://raw.githubusercontent.com/sunny9577/proxy-scraper/refs/heads/master/generated/http_proxies.txt',
      protocol: 'http'
    },
    { url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/refs/heads/main/connect.txt', protocol: 'http' },
    { url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/refs/heads/main/https.txt', protocol: 'https' },
    { url: 'https://spys.me/proxy.txt', protocol: 'http' },
    { url: 'https://us-proxy.org/', protocol: 'http' },

    // --- SOCKS4 ---
    { url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4', protocol: 'socks4' },
    { url: 'https://api.proxyscrape.com/v3/free-proxy-list/get?request=getproxies&protocol=socks4', protocol: 'socks4' },
    { url: 'https://openproxylist.xyz/socks4.txt', protocol: 'socks4' },
    {
      url: 'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/refs/heads/main/proxy_files/socks4_proxies.txt',
      protocol: 'socks4'
    },
    { url: 'https://raw.githubusercontent.com/ObcbO/getproxy/refs/heads/master/file/socks4.txt', protocol: 'socks4' },
    { url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/refs/heads/master/socks4.txt', protocol: 'socks4' },
    { url: 'https://raw.githubusercontent.com/TuanMinPay/live-proxy/refs/heads/master/socks4.txt', protocol: 'socks4' },
    {
      url: 'https://raw.githubusercontent.com/cyberh4ck3r/free-proxy-list/refs/heads/main/socks4-proxies.txt',
      protocol: 'socks4'
    },
    {
      url: 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/refs/heads/master/socks4.txt',
      protocol: 'socks4'
    },
    {
      url: 'https://raw.githubusercontent.com/dinoz0rg/proxy-list/refs/heads/main/checked_proxies/socks4.txt',
      protocol: 'socks4'
    },
    { url: 'https://raw.githubusercontent.com/dpangestuw/Free-PROXY/refs/heads/main/socks4_proxies.txt', protocol: 'socks4' },
    {
      url: 'https://raw.githubusercontent.com/ebrasha/abdal-proxy-hub/refs/heads/main/socks4-proxy-list-by-EbraSha.txt',
      protocol: 'socks4'
    },
    { url: 'https://raw.githubusercontent.com/hproxy-com/free-proxy-list/refs/heads/main/socks4.txt', protocol: 'socks4' },
    {
      url: 'https://raw.githubusercontent.com/iplocate/free-proxy-list/refs/heads/main/protocols/socks4.txt',
      protocol: 'socks4'
    },
    {
      url: 'https://raw.githubusercontent.com/mauricegift/free-proxies/refs/heads/master/files/socks4.json',
      protocol: 'socks4'
    },
    {
      url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/protocols/socks4/data.txt',
      protocol: 'socks4'
    },
    { url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/refs/heads/main/SOCKS4_RAW.txt', protocol: 'socks4' },
    {
      url: 'https://raw.githubusercontent.com/sunny9577/proxy-scraper/refs/heads/master/generated/socks4_proxies.txt',
      protocol: 'socks4'
    },
    { url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/refs/heads/main/socks4.txt', protocol: 'socks4' },

    // --- SOCKS5 ---
    { url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5', protocol: 'socks5' },
    { url: 'https://api.proxyscrape.com/v3/free-proxy-list/get?request=getproxies&protocol=socks5', protocol: 'socks5' },
    { url: 'https://openproxylist.xyz/socks5.txt', protocol: 'socks5' },
    {
      url: 'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/refs/heads/main/proxy_files/socks5_proxies.txt',
      protocol: 'socks5'
    },
    { url: 'https://raw.githubusercontent.com/ObcbO/getproxy/refs/heads/master/file/socks5.txt', protocol: 'socks5' },
    { url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/refs/heads/master/socks5.txt', protocol: 'socks5' },
    { url: 'https://raw.githubusercontent.com/TuanMinPay/live-proxy/refs/heads/master/socks5.txt', protocol: 'socks5' },
    {
      url: 'https://raw.githubusercontent.com/cyberh4ck3r/free-proxy-list/refs/heads/main/socks5-proxies.txt',
      protocol: 'socks5'
    },
    {
      url: 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/refs/heads/master/socks5.txt',
      protocol: 'socks5'
    },
    {
      url: 'https://raw.githubusercontent.com/dinoz0rg/proxy-list/refs/heads/main/checked_proxies/socks5.txt',
      protocol: 'socks5'
    },
    { url: 'https://raw.githubusercontent.com/dpangestuw/Free-PROXY/refs/heads/main/socks5_proxies.txt', protocol: 'socks5' },
    {
      url: 'https://raw.githubusercontent.com/ebrasha/abdal-proxy-hub/refs/heads/main/socks5-proxy-list-by-EbraSha.txt',
      protocol: 'socks5'
    },
    { url: 'https://raw.githubusercontent.com/hookzof/socks5_list/refs/heads/master/proxy.txt', protocol: 'socks5' },
    { url: 'https://raw.githubusercontent.com/hproxy-com/free-proxy-list/refs/heads/main/socks5.txt', protocol: 'socks5' },
    {
      url: 'https://raw.githubusercontent.com/iplocate/free-proxy-list/refs/heads/main/protocols/socks5.txt',
      protocol: 'socks5'
    },
    {
      url: 'https://raw.githubusercontent.com/mauricegift/free-proxies/refs/heads/master/files/socks5.json',
      protocol: 'socks5'
    },
    {
      url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/protocols/socks5/data.txt',
      protocol: 'socks5'
    },
    { url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/refs/heads/main/SOCKS5_RAW.txt', protocol: 'socks5' },
    {
      url: 'https://raw.githubusercontent.com/sunny9577/proxy-scraper/refs/heads/master/generated/socks5_proxies.txt',
      protocol: 'socks5'
    },
    { url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/refs/heads/main/socks5.txt', protocol: 'socks5' },
    { url: 'https://socks-proxy.net/', protocol: 'socks5' }
  ];

  async fetchProxies(options: ProxyFetchOptions): Promise<ProxyRecord[]> {
    const results: ProxyRecord[] = [];
    let successCount = 0;
    const attemptCount = ScraperCheckerProvider.SOURCES.length;

    const queue = [...ScraperCheckerProvider.SOURCES];
    const worker = async (): Promise<void> => {
      let entry = queue.shift();
      while (entry) {
        const text = await this.fetchOne(entry.url, options.signal);
        if (text) {
          successCount++;
          // Cap per-source: some of these lists run to several thousand
          // lines, and taking all of them from every one of the ~70
          // sources can add up to a candidate pool ProxyManager would
          // then have to validate one by one — this keeps any single
          // source from dominating that pool (ProxyManager's own
          // maxCandidatesPerReload cap handles the overall total).
          results.push(...extractProxies(text, entry.protocol, this.name).slice(0, ScraperCheckerProvider.MAX_PER_SOURCE));
        }
        entry = queue.shift();
      }
    };

    const workerCount = Math.min(ScraperCheckerProvider.MAX_CONCURRENT_FETCHES, attemptCount);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (options.signal?.aborted) return results;

    // A handful of dead sources is normal (repos get renamed or abandoned) —
    // that's why each fetch fails silently on its own. But if literally
    // every source failed, that's a real network problem (offline, DNS
    // blocked, firewalled), not "no proxies today" — surface it as an
    // error rather than a clean, misleading 0.
    if (successCount === 0) {
      throw new Error(`All ${attemptCount} source lists were unreachable`);
    }

    return results;
  }

  private async fetchOne(url: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ScraperCheckerProvider.FETCH_TIMEOUT_MS);
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ProxyDesk' }
        });
        if (!response.ok) return null;
        // See PublicProxyProvider's fetchOne for why the timer must stay
        // armed through the body read (via `finally`) instead of being
        // cleared right after fetch() resolves — clearing it early left a
        // slow-body source able to hang this fetch, and with ~90 fetches
        // across a worker pool whose outer Promise.all this file's caller
        // (and ProxyManager.reload) awaits, one stuck source was enough to
        // hang the entire reload, imported proxies included.
        return await response.text();
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Network failure, timeout, DNS failure, or the source being gone —
      // fails gracefully so the rest of the sources still get a chance.
      return null;
    }
  }
}

/**
 * Bare IPv4:port scan across whatever text a source returned — a plain
 * list, an HTML page, or JSON. Deliberately IPv4-only (not hostnames) to
 * keep false positives from unrelated digit-and-colon text out of the
 * results; each octet is range-checked so junk like "999.999.999.999"
 * never turns into a record that would just fail validation anyway.
 */
const HOST_PORT_RE = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})\b/g;

function isValidIPv4(host: string): boolean {
  return host.split('.').every((octet) => {
    const n = Number(octet);
    return octet.length <= 3 && Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/** Exported for unit testing — see tests/scraperCheckerProvider.test.ts. */
export function extractProxies(text: string, protocol: ProxyProtocol, source: string): ProxyRecord[] {
  const found: ProxyRecord[] = [];
  const seen = new Set<string>();
  HOST_PORT_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = HOST_PORT_RE.exec(text))) {
    const host = match[1];
    const port = Number(match[2]);
    if (port <= 0 || port > 65535) continue;
    if (!isValidIPv4(host)) continue;

    const id = `${protocol}://${host}:${port}`;
    if (seen.has(id)) continue;
    seen.add(id);

    found.push(toProxyRecord({ host, port, protocol }, source));
  }

  return found;
}
