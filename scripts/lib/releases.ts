/**
 * How a firmware entry's versions[] relate to its GitHub repo's releases and tags.
 * Shared by the /discover release sweep (.claude/skills/discover/candidates.ts),
 * which reports newer releases, and scripts/releases/sync.ts, which adds them to
 * the entries a pull request changes.
 */

export interface VersionRow {
  version: string;
  date?: string;
  url?: string;
}

/** `main @ 1a2b3c4` style versions, which track the latest commit of a branch. */
export const COMMIT_VERSION = /^(\S+) @ ([0-9a-f]{7,40})$/i;

/** owner, repo, and for `/tree/<branch>/<path>` sources the branch and path. */
export const GITHUB_SOURCE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/\s]+)(?:\/(\S+?))?)?\/?$/;

/** Repos whose releases cover many unrelated entries (PortMaster-New ships every port at once). */
export const SWEEP_SKIP_REPOS = new Set(['portsmaster/portmaster-new']);

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const isoDay = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10);

/** `smk-pad-lights-953` → "smk", `kit v0.5.0` → "kit"; plain versions such as `v1.2` have none. */
export function versionPrefix(v: string): string | undefined {
  if (/^v?\d/i.test(v)) return undefined;
  return /^([a-z][a-z0-9]*)[-_ ]/i.exec(v)?.[1].toLowerCase();
}

/** True when the tag, with or without its leading v, already appears in the file as a whole version. */
export function mentions(text: string, tag: string): boolean {
  const forms = new Set([tag.toLowerCase(), tag.toLowerCase().replace(/^v(?=\d)/, '')]);
  return [...forms].some((f) => new RegExp(`(?<![\\w.-])${escapeRe(f)}(?![\\w-]|\\.\\d)`).test(text));
}

/** True when a row of versions[] is this tag: by its version string, or by a URL that ends in the tag. */
export function listed(versions: VersionRow[], tag: string): boolean {
  const bare = (v: string) => v.toLowerCase().replace(/^v(?=\d)/, '');
  const inUrl = (url: string) => {
    let path = url;
    try {
      path = decodeURIComponent(url);
    } catch {
      // Keep the raw URL.
    }
    return path.endsWith(`/tag/${tag}`) || path.endsWith(`/tree/${tag}`);
  };
  return versions.some((v) => bare(v.version) === bare(tag) || (v.url !== undefined && inUrl(v.url)));
}

/** The tag a row's release or tree URL points at, decoded; undefined for other URLs. */
export function tagInUrl(url?: string): string | undefined {
  const raw = /\/(?:tag|tree)\/([^/?#]+)\/?$/.exec(url ?? '')?.[1];
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * How one row writes its tag as a version, or undefined when the two don't relate simply:
 *   - a prefix left off: `0.9.77` for tag `loaf-v0.9.77`, `1.1.1` for `v1.1.1`;
 *   - other separators: `build 851` for tag `build-851`.
 */
function spellingRule(tag: string, version: string): ((tag: string) => string) | undefined {
  if (tag.length > version.length && tag.toLowerCase().endsWith(version.toLowerCase())) {
    const prefix = tag.slice(0, tag.length - version.length);
    // The prefix must end where the version really starts: not inside a number (`v0.` + `1`) or a word.
    const insideNumber = /[\d.]$/.test(prefix);
    const insideWord = /[a-z]$/i.test(prefix) && /^[a-z]/i.test(version);
    if (insideNumber || insideWord) return undefined;
    const numeric = /^\d/.test(version);
    return (t) => {
      if (!t.toLowerCase().startsWith(prefix.toLowerCase())) return t;
      const rest = t.slice(prefix.length);
      return rest && (!numeric || /^\d/.test(rest)) ? rest : t;
    };
  }
  if (tag.length === version.length) {
    const swaps = new Map<string, string>();
    for (let i = 0; i < tag.length; i++) {
      const [a, b] = [tag[i], version[i]];
      if (a === b) continue;
      if (!/[-_ ]/.test(a) || !/[-_ ]/.test(b) || (swaps.has(a) && swaps.get(a) !== b)) return undefined;
      swaps.set(a, b);
    }
    if (swaps.size) return (t) => t.replace(/[-_ ]/g, (c) => swaps.get(c) ?? c);
  }
  return undefined;
}

/**
 * Spells a new tag the way the entry's rows spell theirs. The newest row whose URL names
 * its tag decides: written as tagged, it keeps tags as they are; otherwise its rule (see
 * spellingRule) applies to every new tag it fits. Rows that show no simple rule, such as a
 * hand-picked `1.9` for tag `V1.90.0`, are passed over for the next one down.
 */
export function versionSpelling(versions: VersionRow[]): (tag: string) => string {
  for (const v of versions) {
    const tag = tagInUrl(v.url);
    if (tag === undefined) continue;
    if (tag === v.version) break;
    const rule = spellingRule(tag, v.version);
    if (rule) return rule;
  }
  return (tag) => tag;
}
