/**
 * The GitHub metrics snapshot: raw signals only, written by `pnpm metrics:fetch`
 * (scripts/metrics/fetch.ts) and read at build time by src/lib/quality.ts.
 * Scores are never stored, so changing a weight or threshold needs no refetch.
 *
 * Storage: the snapshot is not committed. It lives as a content-addressed asset
 * `repo-metrics-<sha12>.json` on the long-lived GitHub release `metrics`, and the
 * committed lock file src/data/repo-metrics.lock.json names the asset and its
 * sha256. Assets are never overwritten, so a commit always builds with the same
 * data.
 *
 * Loading (loadMetrics):
 *   - The asset is looked up in node_modules/.cache/metrics/ first. A file there
 *     whose sha256 matches the lock is used as is, which is also how a locally
 *     fetched snapshot that is not published yet works for dev and builds.
 *   - Otherwise it is downloaded from the public release (no token) and verified.
 *   - ALTSTRUMENT_SKIP_REMOTE=1 skips the download. Without the exact asset in the
 *     cache, the newest cached snapshot is used with a warning; with no cache at
 *     all, there is no snapshot (every entry is limited data, no ratings).
 *   - A failed download falls back to the newest cached snapshot with a warning;
 *     with no cache it fails, so a build never silently loses its ratings.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const METRICS_REPO = 'philmillman/altstrument';
export const METRICS_TAG = 'metrics';
export const LOCK_FILE = 'src/data/repo-metrics.lock.json';
export const CACHE_DIR = 'node_modules/.cache/metrics';
const ASSET_NAME = /^repo-metrics-[0-9a-f]{12}\.json$/;

/** One fork as listed by GitHub (top forks by stars). */
export interface ForkMetrics {
  /** owner/repo */
  name: string;
  stars: number;
  createdAt: string;
  pushedAt: string;
}

/** Repo-level signals, shared by every entry whose source is in this repo. */
export interface RepoMetrics {
  /** owner/repo as GitHub spells it now (after renames/transfers). */
  name: string;
  /**
   * When this record was last confirmed current (ISO). Time-based signals
   * (age, recency) are measured from here; absent in records from before
   * per-repo times, which use the snapshot's fetchedAt.
   */
  fetchedAt?: string;
  /**
   * When commit history, forks and contributors were last fetched (ISO).
   * `commitsLastYear` counts the 365 days before this. A refresh skips these
   * when `pushedAt` has not changed.
   */
  historyAt?: string;
  createdAt: string;
  pushedAt: string;
  archived: boolean;
  /** owner/repo of the GitHub fork parent, when this repo is a fork. */
  parent?: string;
  stars: number;
  forks: number;
  watchers: number;
  releases: number;
  /** Newest and oldest release publish dates (ISO), when there are releases. */
  latestRelease?: string;
  firstRelease?: string;
  /** Newest release tag looks like a stable ≥1.0 version (no -beta/-rc/-alpha). */
  stableRelease: boolean;
  /** Commits on the default branch: all time and in the 365 days before historyAt. */
  commits: number;
  commitsLastYear: number;
  /** Date of the newest commit on the default branch (ISO). */
  lastCommit?: string;
  hasIssues: boolean;
  issuesOpen: number;
  issuesClosed: number;
  prsMerged: number;
  /** All PRs: open, closed and merged. */
  prsTotal: number;
  hasDiscussions: boolean;
  discussions: number;
  /** Contributors including anonymous ones (REST /contributors?anon=1). */
  contributors: number;
  /** Fewest contributors who made 50% of the commits (CHAOSS Contributor Absence Factor). */
  busFactor: number;
  /** ETag of the first /contributors page, for conditional requests (a 304 is free). */
  contributorsEtag?: string;
  /** Top forks by stars, at most 100. */
  topForks: ForkMetrics[];
  /**
   * Forks only (`parent` set): commits on the default branch since the fork was
   * created, and the distinct authors among the newest 100 of them. A fork's
   * `commits` and `contributors` include its parent's history, so scoring
   * uses these instead.
   */
  ownCommits?: number;
  ownAuthors?: number;
}

/** Signals for an entry whose source is a subdirectory of a repo (monorepos). */
export interface PathMetrics {
  /** As on RepoMetrics. */
  fetchedAt?: string;
  historyAt?: string;
  commits: number;
  commitsLastYear: number;
  lastCommit?: string;
}

export interface MetricsSnapshot {
  /**
   * ISO time of the last full refresh (`--full`), or of the first fetch. Top-up
   * runs leave it alone; each record carries its own fetchedAt.
   */
  fetchedAt: string;
  /** Keyed by lower-case `owner/repo` as written in the entry's source URL. */
  repos: Record<string, RepoMetrics>;
  /** Keyed by lower-case `owner/repo` + `:` + path as written in the source URL. */
  paths: Record<string, PathMetrics>;
  /** Repos that could not be fetched (renamed away, deleted, private), with the error. */
  missing: Record<string, string>;
}

/** The committed pointer to the snapshot asset. */
export interface MetricsLock {
  /** repo-metrics-<first 12 hex of sha256>.json */
  asset: string;
  sha256: string;
  /** The snapshot's fetchedAt. */
  fetchedAt: string;
  /** Number of repo records. */
  repos: number;
}

export interface GithubSource {
  owner: string;
  repo: string;
  branch?: string;
  path?: string;
  /** Lower-case `owner/repo`. */
  key: string;
  /** Lower-case `owner/repo:path`, when there is a path. */
  pathKey?: string;
}

const GITHUB_SOURCE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/\s]+)(?:\/(\S+?))?)?\/?$/;

/** Parses a `source` URL of the form github.com/owner/repo[/tree/branch[/path]]. */
export function parseGithubSource(source: string | undefined): GithubSource | undefined {
  const m = source ? GITHUB_SOURCE.exec(source) : null;
  if (!m) return undefined;
  const [, owner, repo, branch, rawPath] = m;
  const key = `${owner}/${repo}`.toLowerCase();
  const path = rawPath?.replace(/\/+$/, '') || undefined;
  return { owner, repo, branch, path, key, pathKey: path ? `${key}:${path}` : undefined };
}

// ---- lock, cache and asset ---------------------------------------------------

export const assetUrl = (asset: string) => `https://github.com/${METRICS_REPO}/releases/download/${METRICS_TAG}/${asset}`;
export const cachePath = (root: string, asset: string) => join(root, CACHE_DIR, asset);
const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

export function parseLock(text: string): MetricsLock {
  const l = JSON.parse(text) as Partial<MetricsLock>;
  if (typeof l.asset !== 'string' || !ASSET_NAME.test(l.asset)) throw new Error(`metrics lock: bad asset name ${JSON.stringify(l.asset)}`);
  if (typeof l.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(l.sha256)) throw new Error('metrics lock: bad sha256');
  if (!l.asset.includes(l.sha256.slice(0, 12))) throw new Error('metrics lock: asset name does not match sha256');
  return { asset: l.asset, sha256: l.sha256, fetchedAt: String(l.fetchedAt ?? ''), repos: Number(l.repos ?? 0) };
}

/** The committed lock, or null when there is none yet. */
export function readLock(root = process.cwd()): MetricsLock | null {
  const file = join(root, LOCK_FILE);
  return existsSync(file) ? parseLock(readFileSync(file, 'utf8')) : null;
}

export function writeLock(root: string, lock: MetricsLock) {
  const file = join(root, LOCK_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
}

const sortKeys = <T>(o: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Canonical bytes of a snapshot: sorted keys, compact JSON. Equal data gives an equal hash. */
export function serializeSnapshot(s: MetricsSnapshot): string {
  return JSON.stringify({ fetchedAt: s.fetchedAt, repos: sortKeys(s.repos), paths: sortKeys(s.paths), missing: sortKeys(s.missing) }) + '\n';
}

function writeAtomic(file: string, data: string | Buffer) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/** Writes the snapshot into the cache under its content-addressed name and returns the lock for it. */
export function storeSnapshot(root: string, s: MetricsSnapshot): MetricsLock {
  const text = serializeSnapshot(s);
  const hash = sha256(text);
  const asset = `repo-metrics-${hash.slice(0, 12)}.json`;
  const file = cachePath(root, asset);
  if (!existsSync(file)) writeAtomic(file, text);
  return { asset, sha256: hash, fetchedAt: s.fetchedAt, repos: Object.keys(s.repos).length };
}

/** The cached asset's bytes when present and matching the lock's sha256. */
export function readCachedAsset(root: string, lock: MetricsLock): Buffer | undefined {
  const file = cachePath(root, lock.asset);
  if (!existsSync(file)) return undefined;
  const buf = readFileSync(file);
  return sha256(buf) === lock.sha256 ? buf : undefined;
}

/** The newest snapshot in the cache (by modification time), for offline fallbacks. */
function newestCached(root: string): { asset: string; buf: Buffer } | undefined {
  const dir = join(root, CACHE_DIR);
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => ASSET_NAME.test(f))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files) {
    const buf = readFileSync(join(dir, f));
    // Only files whose name matches their content.
    if (sha256(buf).startsWith(f.slice('repo-metrics-'.length, -'.json'.length))) return { asset: f, buf };
  }
  return undefined;
}

async function download(url: string): Promise<{ status: number; buf?: Buffer }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'altstrument-build' }, signal: AbortSignal.timeout(60_000) });
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return { status: res.status, buf: res.ok ? Buffer.from(await res.arrayBuffer()) : undefined };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`${url}: ${(lastErr as Error)?.message ?? lastErr}`);
}

export interface LoadedSnapshot {
  snapshot: MetricsSnapshot;
  /** Where the bytes came from: the cache (exact asset), a download, or an older cached asset. */
  from: 'cache' | 'download' | 'stale-cache';
  asset: string;
}

const parseSnapshot = (buf: Buffer): MetricsSnapshot => {
  const s = JSON.parse(buf.toString('utf8')) as MetricsSnapshot;
  return { fetchedAt: s.fetchedAt, repos: s.repos ?? {}, paths: s.paths ?? {}, missing: s.missing ?? {} };
};

/**
 * The snapshot a lock points to: from the cache, else downloaded, verified and
 * cached. See the header for the offline and failure fallbacks.
 */
export async function loadSnapshotForLock(
  lock: MetricsLock,
  root = process.cwd(),
  opts: { skipRemote?: boolean; warn?: (msg: string) => void } = {},
): Promise<LoadedSnapshot | null> {
  const warn = opts.warn ?? ((m: string) => console.warn(`[metrics] ${m}`));
  const skipRemote = opts.skipRemote ?? !!process.env.ALTSTRUMENT_SKIP_REMOTE;
  const cached = readCachedAsset(root, lock);
  if (cached) return { snapshot: parseSnapshot(cached), from: 'cache', asset: lock.asset };

  const fallback = (why: string): LoadedSnapshot | null => {
    const old = newestCached(root);
    if (old) {
      warn(`${why}; using the cached ${old.asset} instead of ${lock.asset}`);
      return { snapshot: parseSnapshot(old.buf), from: 'stale-cache', asset: old.asset };
    }
    return null;
  };

  if (skipRemote) {
    const r = fallback('ALTSTRUMENT_SKIP_REMOTE set');
    if (!r) warn(`ALTSTRUMENT_SKIP_REMOTE set and ${lock.asset} is not cached; building without GitHub metrics`);
    return r;
  }

  let res: { status: number; buf?: Buffer };
  try {
    res = await download(assetUrl(lock.asset));
  } catch (e) {
    const r = fallback(`download failed (${(e as Error).message})`);
    if (r) return r;
    throw new Error(`GitHub metrics: ${lock.asset} could not be downloaded and nothing is cached. ${(e as Error).message}`);
  }
  if (res.status === 404) {
    throw new Error(
      `GitHub metrics: ${lock.asset} (${LOCK_FILE}) is not on the "${METRICS_TAG}" release. ` +
        'Run `pnpm metrics:publish` where it was fetched, or `pnpm metrics:fetch --missing` to make a new one.',
    );
  }
  if (!res.buf) throw new Error(`GitHub metrics: ${assetUrl(lock.asset)}: HTTP ${res.status}`);
  if (sha256(res.buf) !== lock.sha256) throw new Error(`GitHub metrics: ${lock.asset} does not match the sha256 in ${LOCK_FILE}`);
  writeAtomic(cachePath(root, lock.asset), res.buf);
  return { snapshot: parseSnapshot(res.buf), from: 'download', asset: lock.asset };
}

/** True when the asset is on the public release (a HEAD request, no token). */
export async function assetPublished(asset: string): Promise<boolean> {
  const res = await fetch(assetUrl(asset), { method: 'HEAD', headers: { 'User-Agent': 'altstrument-build' }, signal: AbortSignal.timeout(30_000) });
  return res.ok;
}

let cached: Promise<MetricsSnapshot | null> | undefined;

/** The snapshot the committed lock points to, or null when there is no lock. Loaded once per process. */
export function loadMetrics(root = process.cwd()): Promise<MetricsSnapshot | null> {
  cached ??= (async () => {
    const lock = readLock(root);
    if (!lock) return null;
    return (await loadSnapshotForLock(lock, root))?.snapshot ?? null;
  })();
  return cached;
}
