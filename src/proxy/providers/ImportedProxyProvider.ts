import type { ProxyFetchOptions, ProxyProvider, ProxyRecord } from '../../shared/types/proxy';

/**
 * Surfaces proxies the user has manually imported (single entries or bulk
 * .txt files) through the same ProxyProvider interface as any other source,
 * so ProxyManager never has to special-case them.
 */
export class ImportedProxyProvider implements ProxyProvider {
  readonly name = 'Imported';
  readonly kind = 'imported' as const;

  constructor(private readonly getImported: () => ProxyRecord[]) {}

  async fetchProxies(options: ProxyFetchOptions): Promise<ProxyRecord[]> {
    const all = this.getImported();
    if (!options.countryCode) return all;
    const upper = options.countryCode.toUpperCase();
    // Imported proxies without a known country are excluded from a
    // country-filtered result rather than assumed to match.
    return all.filter((p) => p.countryCode?.toUpperCase() === upper);
  }
}
