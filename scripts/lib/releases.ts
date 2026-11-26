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
