import type { ProxyProtocol, ProxyRecord } from '../shared/types/proxy';

const PROTOCOLS: ProxyProtocol[] = ['http', 'https', 'socks4', 'socks5'];

/** Loose IPv4/hostname check — deliberately permissive about hostnames
 * (proxies are sometimes given as domain names) but rejects obvious junk. */
const HOST_RE = /^[a-zA-Z0-9.-]+$/;

export interface ParsedProxyInput {
  host: string;
  port: number;
  protocol: ProxyProtocol;
  username?: string;
  password?: string;
}

export class ProxyParseError extends Error {
  constructor(public readonly line: string, message: string) {
    super(message);
    this.name = 'ProxyParseError';
  }
}

/**
 * Parses proxies from the formats the Import Proxy dialog accepts:
 *   - http://host:port
 *   - http://user:pass@host:port
 *   - socks5://host:port
 *   - host:port
 *   - host:port:username:password
 * Never throws on malformed input from bulk imports — callers should use
 * `tryParseLine` and collect failures; `parseLine` (throwing) is for
 * single-proxy form fields where an immediate error message is wanted.
 */
export class ProxyParser {
  static tryParseLine(rawLine: string): ParsedProxyInput | null {
    try {
      return ProxyParser.parseLine(rawLine);
    } catch {
      return null;
    }
  }

  static parseLine(rawLine: string): ParsedProxyInput {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      throw new ProxyParseError(rawLine, 'Empty or comment line');
    }

    if (line.includes('://')) {
      return ProxyParser.parseUrlForm(line);
    }

    return ProxyParser.parseColonForm(line);
  }

  private static parseUrlForm(line: string): ParsedProxyInput {
    let url: URL;
    try {
      url = new URL(line);
    } catch {
      throw new ProxyParseError(line, 'Not a valid proxy URL');
    }

    const protocol = url.protocol.replace(':', '').toLowerCase() as ProxyProtocol;
    if (!PROTOCOLS.includes(protocol)) {
      throw new ProxyParseError(line, `Unsupported protocol "${protocol}"`);
    }

    const host = decodeURIComponent(url.hostname);
    if (!host || !HOST_RE.test(host)) {
      throw new ProxyParseError(line, 'Invalid host');
    }

    const port = url.port ? Number(url.port) : defaultPortFor(protocol);
    validatePort(port, line);

    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;

    return { host, port, protocol, username, password };
  }

  private static parseColonForm(line: string): ParsedProxyInput {
    const parts = line.split(':').map((p) => p.trim());

    if (parts.length === 2) {
      const [host, portStr] = parts;
      const port = Number(portStr);
      validateHost(host, line);
      validatePort(port, line);
      return { host, port, protocol: 'http' };
    }

    if (parts.length === 4) {
      const [host, portStr, username, password] = parts;
      const port = Number(portStr);
      validateHost(host, line);
      validatePort(port, line);
      return { host, port, protocol: 'http', username, password };
    }

    throw new ProxyParseError(line, 'Unrecognized proxy format');
  }
}

function validateHost(host: string, line: string): void {
  if (!host || !HOST_RE.test(host)) {
    throw new ProxyParseError(line, 'Invalid host');
  }
}

function validatePort(port: number, line: string): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ProxyParseError(line, 'Invalid port');
  }
}

function defaultPortFor(protocol: ProxyProtocol): number {
  switch (protocol) {
    case 'https':
      return 443;
    case 'socks4':
    case 'socks5':
      return 1080;
    case 'http':
    default:
      return 8080;
  }
}

/** Deterministic identity for dedup: protocol + host + port. */
export function buildProxyId(input: Pick<ParsedProxyInput, 'protocol' | 'host' | 'port'>): string {
  return `${input.protocol}://${input.host.toLowerCase()}:${input.port}`;
}

export function toProxyRecord(
  input: ParsedProxyInput,
  source: string,
  extra: Partial<ProxyRecord> = {}
): ProxyRecord {
  return {
    id: buildProxyId(input),
    host: input.host,
    port: input.port,
    protocol: input.protocol,
    username: input.username,
    password: input.password,
    countryCode: extra.countryCode,
    country: extra.country,
    countryVerified: extra.countryVerified ?? false,
    sources: [source],
    status: 'unknown',
    score: 0,
    successCount: 0,
    failureCount: 0,
    ...extra
  };
}

export interface BulkParseResult {
  proxies: ProxyRecord[];
  invalidLines: string[];
}

/** Parses a multi-line block (e.g. an imported .txt file), never throwing. */
export function parseBulkText(text: string, source: string): BulkParseResult {
  const proxies: ProxyRecord[] = [];
  const invalidLines: string[] = [];

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    try {
      const parsed = ProxyParser.parseLine(line);
      proxies.push(toProxyRecord(parsed, source));
    } catch {
      invalidLines.push(line);
    }
  }

  return { proxies, invalidLines };
}

/** Merges duplicate proxies (same protocol+host+port), combining source lists. */
export function dedupeProxies(proxies: ProxyRecord[]): ProxyRecord[] {
  const byId = new Map<string, ProxyRecord>();

  for (const proxy of proxies) {
    const existing = byId.get(proxy.id);
    if (!existing) {
      byId.set(proxy.id, { ...proxy, sources: [...proxy.sources] });
      continue;
    }

    const mergedSources = Array.from(new Set([...existing.sources, ...proxy.sources]));
    byId.set(proxy.id, {
      ...existing,
      sources: mergedSources,
      // Prefer whichever record has verified country metadata.
      countryCode: existing.countryVerified ? existing.countryCode : proxy.countryCode ?? existing.countryCode,
      country: existing.countryVerified ? existing.country : proxy.country ?? existing.country,
      countryVerified: existing.countryVerified || proxy.countryVerified,
      username: existing.username ?? proxy.username,
      password: existing.password ?? proxy.password
    });
  }

  return Array.from(byId.values());
}
