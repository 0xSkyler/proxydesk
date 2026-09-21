import https from 'node:https';

export const PROXYSCRAPE_FREE_API =
  'https://api.proxyscrape.com/v4/free-proxy-list/get';

export interface ProxyScrapeFetchOptions {
  limit?: number;
  timeoutFilterMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Fetch ProxyScrape's public free-proxy feed directly.
 *
 * ProxyScrape documents a maximum page size of 2,000 proxies and supports
 * filtering by protocol and timeout. We request protocol-qualified output so
 * the existing parser can preserve HTTP / SOCKS4 / SOCKS5 correctly.
 */
export function buildProxyScrapeFreeListUrl(
  options: Pick<ProxyScrapeFetchOptions, 'limit' | 'timeoutFilterMs'> = {}
): URL {
  const limit = Math.max(1, Math.min(2000, Math.floor(options.limit ?? 2000)));
  const timeoutFilterMs = Math.max(1000, Math.min(15_000, Math.floor(options.timeoutFilterMs ?? 7000)));

  const url = new URL(PROXYSCRAPE_FREE_API);
  url.searchParams.set('request', 'display_proxies');
  url.searchParams.set('protocol', 'all');
  url.searchParams.set('timeout', String(timeoutFilterMs));
  url.searchParams.set('country', 'all');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('proxy_format', 'protocolipport');
  url.searchParams.set('format', 'text');
  return url;
}

export async function fetchProxyScrapeFreeList(
  options: ProxyScrapeFetchOptions = {}
): Promise<string> {
  const requestTimeoutMs = Math.max(3000, Math.min(30_000, Math.floor(options.requestTimeoutMs ?? 15_000)));
  const url = buildProxyScrapeFreeListUrl(options);

  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('ProxyScrape request aborted.'));
      return;
    }

    const request = https.get(
      url,
      {
        headers: {
          accept: 'text/plain,*/*;q=0.8',
          'user-agent': 'ProxyDesk-SEO-Lite/1.0'
        }
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new Error(`ProxyScrape API returned HTTP ${statusCode}.`));
          return;
        }

        response.setEncoding('utf8');
        let body = '';
        response.on('data', (chunk: string) => {
          body += chunk;
          // A 2,000-proxy text response is tiny. Guard against a bad upstream
          // response anyway so this never becomes an unbounded memory sink.
          if (body.length > 2_000_000) {
            request.destroy(new Error('ProxyScrape response exceeded the safety limit.'));
          }
        });
        response.on('end', () => resolve(body));
      }
    );

    request.setTimeout(requestTimeoutMs, () => {
      request.destroy(new Error(`ProxyScrape API timed out after ${requestTimeoutMs} ms.`));
    });

    const onAbort = () => request.destroy(new Error('ProxyScrape request aborted.'));
    options.signal?.addEventListener('abort', onAbort, { once: true });

    request.on('close', () => options.signal?.removeEventListener('abort', onAbort));
    request.on('error', reject);
  });
}
