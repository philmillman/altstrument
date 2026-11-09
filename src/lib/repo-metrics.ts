/**
 * The GitHub metrics snapshot (src/data/repo-metrics.json): raw signals only,
 * written by `pnpm metrics:fetch` (scripts/metrics/fetch.ts) and read at build
 * time by src/lib/quality.ts. Scores are never stored, so changing a weight or
 * threshold needs no refetch.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const METRICS_FILE = 'src/data/repo-metrics.json';

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
  /** Commits on the default branch: all time and in the 365 days before fetchedAt. */
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
  commits: number;
  commitsLastYear: number;
  lastCommit?: string;
}

export interface MetricsSnapshot {
  /** ISO timestamp of the fetch run. */
  fetchedAt: string;
  /** Keyed by lower-case `owner/repo` as written in the entry's source URL. */
  repos: Record<string, RepoMetrics>;
  /** Keyed by lower-case `owner/repo` + `:` + path as written in the source URL. */
  paths: Record<string, PathMetrics>;
  /** Repos that could not be fetched (renamed away, deleted, private), with the error. */
  missing: Record<string, string>;
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

let cached: MetricsSnapshot | null | undefined;

/** The committed snapshot, or null when it does not exist yet. Read once per process. */
export function loadMetrics(root = process.cwd()): MetricsSnapshot | null {
  if (cached === undefined) {
    const file = join(root, METRICS_FILE);
    cached = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as MetricsSnapshot) : null;
  }
  return cached;
}
