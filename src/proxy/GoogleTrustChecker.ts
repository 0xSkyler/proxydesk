import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { GoogleTrustStatus, ProxyRecord } from '../shared/types/proxy';
import { buildAgent } from './ProxyValidator';

export interface GoogleTrustResult {
  proxyId: string;
  status: GoogleTrustStatus;
  error?: string;
  checkedAt: string;
}

export interface GoogleTrustOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

// A real, ordinary-looking search — specific enough that Google would serve
// real results for it, generic enough not to look like automated probing on
// its own. What matters isn't the query, it's whether the *response* is a
// results page or an interstitial.
const PROBE_PATH = '/search?q=weather+today&num=10&hl=en';

// Substrings that show up on Google's "unusual traffic" / CAPTCHA
// interstitial (the same page shown in the user's screenshots) or its
// redirect target, checked case-insensitively. Any one of these appearing
// in the response body (regardless of HTTP status — Google serves this
// page with 200, 302, and 429 depending on the exact trigger) means the
// proxy's IP is currently flagged, independent of whether it can otherwise
// route traffic at all.
const BLOCK_SIGNATURES = [
  'unusual traffic from your computer network',
  'systems have detected unusual traffic',
  'id="captcha-form"',
  '/sorry/index',
  'recaptcha'
];

function clampTimeout(ms: number): number {
  return Math.min(60000, Math.max(2000, ms));
}

/**
 * Routes one real Google Search request through the given proxy and
 * classifies the response as 'trusted' (a normal results page came back) or
 * 'blocked' (Google's bot-detection interstitial came back instead). This is
 * deliberately separate from ProxyValidator's connectivity check — a proxy
 * can be perfectly reachable ('working') while still being an IP that
 * Google itself has already flagged, which is exactly the CAPTCHA problem
 * this exists to surface *before* assigning that proxy to a browser, rather
 * than discovering it only after a browser hits the interstitial live.
 */
export async function checkGoogleTrust(proxy: ProxyRecord, options: GoogleTrustOptions = {}): Promise<GoogleTrustResult> {
  const timeoutMs = clampTimeout(options.timeoutMs ?? 15000);
  const checkedAt = new Date().toISOString();

  let agent: ReturnType<typeof buildAgent>;
  try {
    agent = buildAgent(proxy);
  } catch (err) {
    return { proxyId: proxy.id, status: 'unknown', error: `Invalid proxy configuration: ${(err as Error).message}`, checkedAt };
  }

  return new Promise<GoogleTrustResult>((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let settled = false;
    const finish = (result: GoogleTrustResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(backstop);
      resolve(result);
    };

    // Same independent wall-clock backstop as ProxyValidator (see its
    // comment) — a proxy that trickles bytes without ever finishing keeps
    // resetting socket-idle timeouts and can otherwise hang this promise,
    // and therefore any bulk "check all" loop, forever.
    const backstop = setTimeout(() => {
      req.destroy();
      finish({ proxyId: proxy.id, status: 'unknown', error: 'Google trust check timed out', checkedAt });
    }, timeoutMs + 1000);

    const req = https.request(
      {
        hostname: 'www.google.com',
        path: PROBE_PATH,
        port: 443,
        method: 'GET',
        agent,
        signal: controller.signal,
        timeout: timeoutMs,
        headers: {
          // A realistic desktop-browser UA — Google's own bot-detection
          // partly keys off this, and an obviously non-browser UA (like the
          // validator's own "ProxyDesk/1.0") would bias the result toward
          // 'blocked' regardless of whether the IP itself is actually clean.
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const lower = body.toLowerCase();
          const blocked = BLOCK_SIGNATURES.some((sig) => lower.includes(sig));

          if (blocked) {
            finish({ proxyId: proxy.id, status: 'blocked', checkedAt });
            return;
          }

          if (!res.statusCode || res.statusCode >= 400) {
            // Not a recognized CAPTCHA page, but not a normal page either
            // (proxy-level error, WAF block, etc.) — genuinely inconclusive
            // rather than a confirmed clean result.
            finish({ proxyId: proxy.id, status: 'unknown', error: `HTTP ${res.statusCode ?? 'unknown'}`, checkedAt });
            return;
          }

          finish({ proxyId: proxy.id, status: 'trusted', checkedAt });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
    });

    req.on('error', (err) => {
      finish({ proxyId: proxy.id, status: 'unknown', error: sanitizeError(err), checkedAt });
    });

    req.end();
  });
}

/** Bounded-concurrency runner, mirroring ProxyValidator.validateMany, so a
 * "check all working proxies" bulk action doesn't fire dozens of concurrent
 * real Google requests through mostly-shared exit patterns at once. */
export async function checkGoogleTrustMany(
  proxies: ProxyRecord[],
  options: GoogleTrustOptions & { maxConcurrent?: number; onProgress?: (checked: number, total: number) => void } = {}
): Promise<GoogleTrustResult[]> {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 3);
  const results: GoogleTrustResult[] = new Array(proxies.length);
  let cursor = 0;
  let completed = 0;

  async function worker() {
    while (cursor < proxies.length) {
      const index = cursor++;
      results[index] = await checkGoogleTrust(proxies[index], options);
      completed++;
      options.onProgress?.(completed, proxies.length);
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrent, proxies.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\/\/[^@/]+@/g, '//***@');
}
