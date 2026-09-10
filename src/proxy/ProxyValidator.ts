import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { ProxyRecord, ProxyValidationResult } from '../shared/types/proxy';
import { DEFAULT_PROXY_TIMEOUT_MS } from '../shared/constants';

export interface ValidateOptions {
  timeoutMs?: number;
  /** Endpoint that returns JSON containing an "ip" field, reached THROUGH the proxy. */
  ipCheckUrl?: string;
  signal?: AbortSignal;
}

function buildAgentUrl(proxy: ProxyRecord): string {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@`
    : '';
  const scheme = proxy.protocol === 'https' ? 'https' : proxy.protocol === 'http' ? 'http' : proxy.protocol;
  return `${scheme}://${auth}${proxy.host}:${proxy.port}`;
}

function buildAgent(proxy: ProxyRecord) {
  const url = buildAgentUrl(proxy);
  if (proxy.protocol === 'socks4' || proxy.protocol === 'socks5') {
    return new SocksProxyAgent(url);
  }
  return new HttpsProxyAgent(url);
}

/**
 * Validates a single proxy by performing a real HTTP request THROUGH it to a
 * configurable IP-check endpoint. This exercises actual proxy traffic rather
 * than merely opening a TCP socket, so a proxy that accepts connections but
 * silently drops requests is correctly reported dead.
 */
export class ProxyValidator {
  static async validate(proxy: ProxyRecord, options: ValidateOptions = {}): Promise<ProxyValidationResult> {
    const timeoutMs = clampTimeout(options.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS);
    const ipCheckUrl = options.ipCheckUrl ?? 'https://api.ipify.org?format=json';
    const checkedAt = new Date().toISOString();
    const start = Date.now();

    let agent: ReturnType<typeof buildAgent>;
    try {
      agent = buildAgent(proxy);
    } catch (err) {
      return {
        proxyId: proxy.id,
        status: 'dead',
        error: `Invalid proxy configuration: ${(err as Error).message}`,
        checkedAt
      };
    }

    return new Promise<ProxyValidationResult>((resolve) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      if (options.signal) {
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      let settled = false;
      const finish = (result: ProxyValidationResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      let target: URL;
      try {
        target = new URL(ipCheckUrl);
      } catch {
        finish({ proxyId: proxy.id, status: 'dead', error: 'Invalid IP check URL', checkedAt });
        return;
      }

      const req = https.request(
        {
          hostname: target.hostname,
          path: `${target.pathname}${target.search}`,
          port: target.port || 443,
          method: 'GET',
          agent,
          signal: controller.signal,
          timeout: timeoutMs,
          headers: { 'User-Agent': 'ProxyDesk/1.0 (+proxy-validation)' }
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const latencyMs = Date.now() - start;
            if (!res.statusCode || res.statusCode >= 400) {
              finish({
                proxyId: proxy.id,
                status: 'dead',
                latencyMs,
                error: `HTTP ${res.statusCode ?? 'unknown'}`,
                checkedAt
              });
              return;
            }
            let detectedIp: string | undefined;
            try {
              const body = Buffer.concat(chunks).toString('utf8');
              const parsed = JSON.parse(body) as { ip?: string };
              detectedIp = parsed.ip;
            } catch {
              // Non-JSON response is still a successful proxied request.
            }
            finish({ proxyId: proxy.id, status: 'working', latencyMs, detectedCountryCode: undefined, checkedAt });
            void detectedIp;
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
      });

      req.on('error', (err) => {
        finish({
          proxyId: proxy.id,
          status: 'dead',
          latencyMs: Date.now() - start,
          error: sanitizeError(err),
          checkedAt
        });
      });

      req.end();
    });
  }

  /** Runs validations with bounded concurrency so 10+ checks never overwhelm the network stack. */
  static async validateMany(
    proxies: ProxyRecord[],
    options: ValidateOptions & { maxConcurrent?: number } = {}
  ): Promise<ProxyValidationResult[]> {
    const maxConcurrent = Math.max(1, options.maxConcurrent ?? 10);
    const results: ProxyValidationResult[] = new Array(proxies.length);
    let cursor = 0;

    async function worker() {
      while (cursor < proxies.length) {
        const index = cursor++;
        results[index] = await ProxyValidator.validate(proxies[index], options);
      }
    }

    const workers = Array.from({ length: Math.min(maxConcurrent, proxies.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }
}

function clampTimeout(ms: number): number {
  return Math.min(60000, Math.max(1000, ms));
}

function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Never let proxy credentials leak into error strings/logs.
  return message.replace(/\/\/[^@/]+@/g, '//***@');
}
