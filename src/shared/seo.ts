/** Pure SEO helpers shared by the main process and unit tests. */
export function normalizeTargetHost(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

export function hostMatchesTarget(url: string, targetWebsite: string): boolean {
  const target = normalizeTargetHost(targetWebsite);
  if (!target) return false;

  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    if (host === target || host.endsWith(`.${target}`)) return true;

    // The UI accepts a website name as well as a full domain. If the user
    // enters "appareldiary", allow a real Google result hosted on
    // "appareldiary.com" (or a subdomain containing that label) to match.
    if (!target.includes('.')) return host.split('.').includes(target);
    return false;
  } catch {
    return false;
  }
}

/**
 * Matches a normalized target hostname when it appears as a visible Google
 * result URL/citation. Tokenizing on URL/text separators avoids substring
 * false positives such as "notappareldiary.com" matching "appareldiary.com".
 *
 * Keep this function self-contained: BrowserManager serializes it into the
 * isolated Google results page when scanning dynamic SERP markup.
 */
export function resultTextMentionsHost(text: string, normalizedTargetHost: string): boolean {
  const target = String(normalizedTargetHost || '')
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  if (!target) return false;

  const normalized = String(text || '').toLowerCase().replace(/www\./g, '');
  const tokens = normalized
    .split(/[\s/|›·,:;()[\]{}?&#=]+/)
    .map((token) => token.replace(/^["'<>]+|["'<>.]+$/g, ''))
    .filter(Boolean);

  const bareSiteName = !target.includes('.');
  return tokens.some((token) =>
    token === target ||
    token.endsWith(`.${target}`) ||
    (bareSiteName && token.startsWith(`${target}.`))
  );
}

export function buildGoogleSearchUrl(query: string, pageIndex = 0): string {
  const safePage = Math.max(0, Math.floor(pageIndex));
  const params = new URLSearchParams({ q: query.trim(), num: '10', hl: 'en' });
  if (safePage > 0) params.set('start', String(safePage * 10));
  return `https://www.google.com/search?${params.toString()}`;
}
