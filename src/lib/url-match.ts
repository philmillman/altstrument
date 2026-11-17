/**
 * URL matching shared by the discover ignore list and the exclusion list
 * (src/data/exclusions.yaml). No Astro imports, so scripts can use it.
 *
 * A pattern matches like this:
 *   - a GitHub, Codeberg or GitLab repo URL matches that repo, whatever follows it
 *     (`https://github.com/jane/fw` matches `.../jane/fw/releases` and `.../jane/fw.git`);
 *   - any other URL, including a bare `https://github.com/<owner>`, matches itself and
 *     everything below it on a path boundary (`.../foo` does not match `.../foobar`);
 *   - a pattern without a scheme and without a path (`example.com`) matches that host
 *     and every subdomain of it.
 * Scheme, a leading `www.`, case and trailing slashes are ignored on both sides.
 */

const GIT_HOSTS = new Set(['github.com', 'codeberg.org', 'gitlab.com']);
/** First path segments on github.com that are not owners. */
const NOT_OWNERS = new Set(['orgs', 'sponsors', 'topics', 'users', 'settings', 'marketplace', 'features', 'about']);

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * `owner/repo` (lowercase) for github.com URLs, `host/owner/repo` for codeberg.org and
 * gitlab.com, undefined for anything else (including gist.github.com and bare owners).
 */
export function repoKey(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!GIT_HOSTS.has(host)) return undefined;
  const [owner, repoRaw] = u.pathname.split('/').filter(Boolean);
  if (!owner || !repoRaw) return undefined;
  if (host === 'github.com' && NOT_OWNERS.has(owner.toLowerCase())) return undefined;
  const key = `${owner}/${repoRaw.replace(/\.git$/i, '')}`.toLowerCase();
  return host === 'github.com' ? key : `${host}/${key}`;
}

/** Lowercase, no scheme, no leading www., no trailing slashes. */
export function normUrl(u: string): string {
  return u
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

interface Prepared {
  norm: string;
  key?: string;
  /** Set for a bare host pattern: matches the host and its subdomains. */
  host?: string;
}

function prepare(pattern: string): Prepared {
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(pattern.trim());
  const norm = normUrl(pattern);
  const key = repoKey(hasScheme ? pattern : `https://${pattern.trim()}`);
  const host = !hasScheme && !norm.includes('/') && !norm.includes('?') ? norm : undefined;
  return { norm, key, host };
}

function matches(p: Prepared, url: string): boolean {
  const norm = normUrl(url);
  if (p.key !== undefined && p.key === repoKey(url)) return true;
  if (p.host !== undefined) {
    const h = hostOf(url) ?? hostOf(`https://${url}`);
    if (h && (h === p.host || h.endsWith(`.${p.host}`))) return true;
  }
  return norm === p.norm || norm.startsWith(`${p.norm}/`) || norm.startsWith(`${p.norm}?`) || norm.startsWith(`${p.norm}#`);
}

export interface UrlPattern {
  url: string;
  /** URLs under this pattern that stay unmatched, e.g. useful repos of an ignored GitHub owner. */
  except?: string[];
}

/** Returns the first entry whose pattern matches a URL (and none of its exceptions), else undefined. */
export function makeUrlMatcher<T extends UrlPattern>(entries: readonly T[]): (url: string) => T | undefined {
  const prepared = entries.map((e) => ({ entry: e, p: prepare(e.url), except: (e.except ?? []).map(prepare) }));
  return (url) => prepared.find(({ p, except }) => matches(p, url) && !except.some((x) => matches(x, url)))?.entry;
}
