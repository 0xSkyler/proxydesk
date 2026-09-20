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
    return host === target || host.endsWith(`.${target}`);
  } catch {
    return false;
  }
}

export function buildGoogleSearchUrl(query: string, pageIndex = 0): string {
  const safePage = Math.max(0, Math.floor(pageIndex));
  const params = new URLSearchParams({ q: query.trim(), num: '10', hl: 'en' });
  if (safePage > 0) params.set('start', String(safePage * 10));
  return `https://www.google.com/search?${params.toString()}`;
}
