import type { ProxyFetchOptions, ProxyProvider, ProxyRecord } from '../../shared/types/proxy';
import type { CustomProviderConfig } from '../../shared/types/settings';
import { toProxyRecord } from '../ProxyParser';

/**
 * Generic, configuration-driven provider for a user's private/paid proxy
 * API. No credentials are ever hard-coded — `apiUrl`/`headers` come from
 * settings, and any API key the user supplies is expected to live in an
 * environment variable or the encrypted settings store, never in source.
 *
 * The response shape is intentionally flexible: `responseArrayPath` is a
 * dot-path to the array of proxy entries within the JSON body (e.g.
 * "data.proxies"), and each entry is expected to look roughly like
 * { host, port, protocol, username?, password?, country? }.
 */
export class CustomProxyProvider implements ProxyProvider {
  readonly kind = 'custom' as const;

  constructor(private readonly config: CustomProviderConfig) {}

  get name(): string {
    return this.config.name || 'Custom Provider';
  }

  async fetchProxies(options: ProxyFetchOptions): Promise<ProxyRecord[]> {
    if (!this.config.enabled || !this.config.apiUrl) return [];

    const url = new URL(this.config.apiUrl);
    if (options.countryCode && this.config.countryParam) {
      url.searchParams.set(this.config.countryParam, options.countryCode);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(url.toString(), {
        method: this.config.method,
        headers: this.config.headers,
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = await response.json();
      const entries = resolvePath(body, this.config.responseArrayPath);
      if (!Array.isArray(entries)) return [];

      const proxies: ProxyRecord[] = [];
      for (const entry of entries) {
        const parsed = parseEntry(entry);
        if (!parsed) continue;
        proxies.push(toProxyRecord(parsed, this.name, {
          country: entry?.country,
          countryCode: entry?.countryCode ?? entry?.country_code,
          countryVerified: Boolean(entry?.countryCode ?? entry?.country_code)
        }));
      }
      return proxies;
    } catch (err) {
      clearTimeout(timer);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}

function resolvePath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function parseEntry(entry: unknown): { host: string; port: number; protocol: 'http' | 'https' | 'socks4' | 'socks5'; username?: string; password?: string } | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const host = typeof e.host === 'string' ? e.host : typeof e.ip === 'string' ? e.ip : undefined;
  const port = Number(e.port);
  const protocolRaw = typeof e.protocol === 'string' ? e.protocol.toLowerCase() : 'http';
  const protocol = (['http', 'https', 'socks4', 'socks5'] as const).includes(protocolRaw as never)
    ? (protocolRaw as 'http' | 'https' | 'socks4' | 'socks5')
    : 'http';

  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;

  return {
    host,
    port,
    protocol,
    username: typeof e.username === 'string' ? e.username : undefined,
    password: typeof e.password === 'string' ? e.password : undefined
  };
}
