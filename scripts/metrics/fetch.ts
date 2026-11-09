/**
 * Fetches GitHub signals for firmware entries' `source` repos into the metrics
 * snapshot (shape and storage: src/lib/repo-metrics.ts). Raw signals only;
 * scores are computed at build time.
 *
 *   pnpm metrics:fetch --missing             only repos and paths referenced by entries but absent from the snapshot
 *   pnpm metrics:fetch --full                every referenced repo (cheap check first, see below)
 *   pnpm metrics:fetch --only <device-slug>  everything for that device's entries (repeatable)
 *     --prune     drop repo/path keys no entry references any more
 *     --resume    skip records fetched in the last 24 hours (to finish an interrupted run)
 *     --publish   upload the result to the `metrics` release (pnpm metrics:publish)
 *
 * Every run starts from the asset the committed lock points to, merges the new
 * data into it, writes the result to node_modules/.cache/metrics/ under its
 * content-addressed name and points src/data/repo-metrics.lock.json at it. A run
 * that changes nothing leaves the lock alone. Long runs checkpoint the same way.
 *
 * API use (the `gh` CLI; GraphQL in aliased batches, REST for contributors):
 *   - `--full` first runs a light GraphQL query for every repo (counts, pushedAt,
 *     archived, releases). Only repos whose pushedAt changed get commit history,
 *     forks and contributors again. Unchanged repos whose last-year commit
 *     count may have aged out (history older than HISTORY_MAX_AGE_DAYS) get a
 *     cheap history and fork-list refresh without contributors.
 *   - Contributors are fetched with If-None-Match on the stored ETag; a 304
 *     keeps the stored numbers and does not count against the rate limit.
 *   - REST waits for the rate-limit reset when it runs low, so a run fits the
 *     Actions GITHUB_TOKEN budget (1,000 REST requests per hour) by waiting.
 *   - The run ends with REST and GraphQL usage.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { parse } from 'yaml';
import {
  cachePath,
  CACHE_DIR,
  LOCK_FILE,
  loadSnapshotForLock,
  parseGithubSource,
  readLock,
  serializeSnapshot,
  storeSnapshot,
  writeLock,
  type ForkMetrics,
  type GithubSource,
  type MetricsLock,
  type MetricsSnapshot,
  type PathMetrics,
  type RepoMetrics,
} from '../../src/lib/repo-metrics.ts';
import { arr, asObj, graphql, progress, sleep, str, type GqlItem, type Obj } from '../lib/github.ts';
import { publish } from './release.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const FIRMWARES = join(ROOT, 'src/content/firmwares');
const WORKSHOP_CACHE = join(ROOT, CACHE_DIR, 'workshop-listing.json');

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 10;
const LIGHT_BATCH = 40;
const LIGHT_CONCURRENCY = 3;
const PATH_BATCH = 20;
const REST_CONCURRENCY = 6;
const CHECKPOINT_EVERY = 200;
const RESUME_MS = DAY_MS;
/** An unchanged repo's last-year commit count is recounted once it is this old. */
const HISTORY_MAX_AGE_DAYS = 28;
/** REST requests kept in reserve before waiting for the rate-limit reset. */
const REST_RESERVE = 25;
/** The Actions GITHUB_TOKEN REST budget, for the end-of-run report. */
const ACTIONS_REST_BUDGET = 1000;
const execFileAsync = promisify(execFile);

const WORKSHOP_DEVICE = 'music-thing-workshop-computer';
const WORKSHOP_REPO = 'TomWhitwell/Workshop_Computer';
const WORKSHOP_BRANCH = 'main';

const chunks = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// ---- entries ---------------------------------------------------------------

function readEntries(): { sources: Map<string, GithubSource[]>; skipped: number } {
  const sources = new Map<string, GithubSource[]>(); // device -> sources
  let skipped = 0;
  for (const device of readdirSync(FIRMWARES, { withFileTypes: true })) {
    if (!device.isDirectory()) continue;
    for (const f of readdirSync(join(FIRMWARES, device.name))) {
      if (!f.endsWith('.yaml')) continue;
      const data = asObj(parse(readFileSync(join(FIRMWARES, device.name, f), 'utf8')));
      const src = parseGithubSource(typeof data?.source === 'string' ? data.source : undefined);
      if (!src) {
        skipped++;
        continue;
      }
      (sources.get(device.name) ?? sources.set(device.name, []).get(device.name)!).push(src);
    }
  }
  return { sources, skipped };
}

/**
 * The generated Workshop Computer cards: every directory of releases/ upstream, as the
 * loader lists them. The listing's ETag is cached locally, so an unchanged upstream
 * answers 304 (free).
 */
async function workshopSources(): Promise<GithubSource[] | undefined> {
  let prev: { etag?: string; cards?: string[] } = {};
  try {
    prev = JSON.parse(readFileSync(WORKSHOP_CACHE, 'utf8'));
  } catch {
    /* none yet */
  }
  let cards: string[] | undefined;
  try {
    const r = await restGet(`repos/${WORKSHOP_REPO}/contents/releases?ref=${WORKSHOP_BRANCH}`, prev.cards ? prev.etag : undefined);
    if (r.status === 304 && prev.cards) cards = prev.cards;
    else if (r.status === 200 && Array.isArray(r.body)) {
      cards = r.body.map((e) => asObj(e)).filter((o) => o?.type === 'dir' && typeof o.name === 'string').map((o) => o!.name as string);
      mkdirSync(dirname(WORKSHOP_CACHE), { recursive: true });
      writeFileSync(WORKSHOP_CACHE, JSON.stringify({ etag: r.etag, cards }));
    } else progress(`Workshop Computer card listing: HTTP ${r.status}`);
  } catch (e) {
    progress(`Workshop Computer card listing failed (${(e as Error).message.split('\n')[0]})`);
  }
  if (!cards) {
    progress('Skipping the Workshop Computer cards');
    return undefined;
  }
  return cards
    .map((name) => parseGithubSource(`https://github.com/${WORKSHOP_REPO}/tree/${WORKSHOP_BRANCH}/releases/${encodeURIComponent(name)}`))
    .filter((s): s is GithubSource => !!s);
}

// ---- GraphQL ---------------------------------------------------------------

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const total = (v: unknown): number => num(asObj(v)?.totalCount);
const iso = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const firstNode = (v: unknown): Obj | undefined => asObj(arr(asObj(v)?.nodes)[0]);

const RATE_LIMIT_ITEM: GqlItem = { alias: 'rl', vars: {}, field: () => 'rateLimit { cost limit remaining resetAt }' };

const gqlStats = { requests: 0, cost: 0, remaining: undefined as number | undefined, limit: undefined as number | undefined, splits: 0 };

function noteRate(data: Obj) {
  gqlStats.requests++;
  const rl = asObj(data.rl);
  if (!rl) return;
  gqlStats.remaining = num(rl.remaining);
  gqlStats.limit = num(rl.limit);
  gqlStats.cost += num(rl.cost);
}

/** Counts, dates and flags: cheap for GraphQL, and enough to tell whether a repo changed. */
const LIGHT_FIELDS = `nameWithOwner createdAt pushedAt isArchived parent { nameWithOwner }
  stargazerCount forkCount watchers { totalCount }
  releases { totalCount }
  recent: releases(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { publishedAt createdAt tagName isPrerelease } }
  oldest: releases(first: 1, orderBy: {field: CREATED_AT, direction: ASC}) { nodes { publishedAt createdAt } }
  hasIssuesEnabled
  open: issues(states: OPEN) { totalCount }
  closed: issues(states: CLOSED) { totalCount }
  prs: pullRequests { totalCount }
  merged: pullRequests(states: MERGED) { totalCount }
  hasDiscussionsEnabled
  discussions { totalCount }`;

const FORKS_FIELD = 'forks(first: 100, orderBy: {field: STARGAZERS, direction: DESC}) { nodes { nameWithOwner stargazerCount createdAt pushedAt } }';

/** Commit history, forks and mentionable users: the slow part. */
const heavyFields = (since: string) => `defaultBranchRef { target { ... on Commit {
    all: history { totalCount }
    yr: history(since: "${since}") { totalCount }
    last: history(first: 1) { nodes { committedDate } }
  } } }
  mentionableUsers { totalCount }
  ${FORKS_FIELD}`;

const repoQuery = (fields: string) => (v: (k: string) => string) => `repository(owner: ${v('o')}, name: ${v('n')}) {\n  ${fields}\n}`;

const STABLE_TAG = /^v?([1-9]\d*)\.\d+/;
const PRE_TAG = /[-_.](alpha|beta|rc)(?![a-z])/i;

type LightMetrics = Omit<RepoMetrics, 'commits' | 'commitsLastYear' | 'lastCommit' | 'contributors' | 'busFactor' | 'topForks' | 'ownCommits' | 'ownAuthors' | 'contributorsEtag' | 'historyAt'>;

function mapLight(r: Obj, at: string): LightMetrics {
  const recent = arr(asObj(r.recent)?.nodes).map((n) => asObj(n)!);
  const newest = recent[0];
  const newestStable = recent.find((n) => n.isPrerelease !== true);
  const oldest = firstNode(r.oldest);
  const parent = str(asObj(r.parent)?.nameWithOwner);
  const tag = typeof newestStable?.tagName === 'string' ? newestStable.tagName : '';
  return {
    name: str(r.nameWithOwner),
    fetchedAt: at,
    createdAt: str(r.createdAt),
    pushedAt: str(r.pushedAt),
    archived: r.isArchived === true,
    ...(parent ? { parent } : {}),
    stars: num(r.stargazerCount),
    forks: num(r.forkCount),
    watchers: total(r.watchers),
    releases: total(r.releases),
    latestRelease: iso(newest?.publishedAt) ?? iso(newest?.createdAt),
    firstRelease: iso(oldest?.publishedAt) ?? iso(oldest?.createdAt),
    stableRelease: STABLE_TAG.test(tag) && !PRE_TAG.test(tag),
    hasIssues: r.hasIssuesEnabled === true,
    issuesOpen: total(r.open),
    issuesClosed: total(r.closed),
    prsMerged: total(r.merged),
    prsTotal: total(r.prs),
    hasDiscussions: r.hasDiscussionsEnabled === true,
    discussions: total(r.discussions),
  };
}

const mapForks = (r: Obj): ForkMetrics[] =>
  arr(asObj(r.forks)?.nodes)
    .map((n) => asObj(n))
    .filter((n): n is Obj => !!n)
    .map((n) => ({ name: str(n.nameWithOwner), stars: num(n.stargazerCount), createdAt: str(n.createdAt), pushedAt: str(n.pushedAt) }));

type RawRepo = { metrics: RepoMetrics; mentionable: number };

function mapRepo(r: Obj, at: string): RawRepo {
  const target = asObj(asObj(r.defaultBranchRef)?.target);
  const m: RepoMetrics = {
    ...mapLight(r, at),
    historyAt: at,
    commits: total(target?.all),
    commitsLastYear: total(target?.yr),
    lastCommit: iso(firstNode(target?.last)?.committedDate),
    contributors: 0,
    busFactor: 0,
    topForks: mapForks(r),
  };
  return { metrics: m, mentionable: total(r.mentionableUsers) };
}

const isTransient = (msg: string) => /timeout|timed out|RESOURCE_LIMITS|502|503|504|something went wrong|EAI_AGAIN|ECONN|socket|ETIMEDOUT/i.test(msg);
const isNotFound = (msg: string) => /could not resolve|not found|NOT_FOUND|404/i.test(msg);

type Outcome<T> = { ok: true; value: T } | { ok: false; message: string; missing: boolean };

/**
 * Runs `build` items for keys in one GraphQL request, halving the batch on timeouts or
 * resource limits. `onResult` is called per key with the alias data or an error.
 */
async function batched<K>(keys: K[], item: (k: K, alias: string) => GqlItem, onResult: (k: K, r: Outcome<Obj>) => void): Promise<void> {
  const items = keys.map((k, i) => item(k, `a${i}`));
  const res = await graphql([...items, RATE_LIMIT_ITEM]);
  if (res.ok) {
    noteRate(res.data);
    const retry: K[] = [];
    keys.forEach((k, i) => {
      const alias = `a${i}`;
      const data = asObj(res.data[alias]);
      const err = res.errors.get(alias);
      if (data) return onResult(k, { ok: true, value: data });
      if (err && isTransient(err) && keys.length > 1) return void retry.push(k);
      onResult(k, { ok: false, message: err ?? 'no data', missing: !!err && isNotFound(err) });
    });
    if (retry.length) {
      gqlStats.splits++;
      await splitRun(retry, item, onResult);
    }
    return;
  }
  if (keys.length > 1) {
    gqlStats.splits++;
    return splitRun(keys, item, onResult);
  }
  // A single key failing outright: retry a couple of times, as GitHub timeouts are often transient.
  for (let attempt = 0; attempt < 2 && isTransient(res.message); attempt++) {
    await sleep(2000 * (attempt + 1));
    const again = await graphql([...items, RATE_LIMIT_ITEM]);
    if (again.ok) {
      noteRate(again.data);
      const data = asObj(again.data.a0);
      const err = again.errors.get('a0');
      if (data) return onResult(keys[0], { ok: true, value: data });
      return onResult(keys[0], { ok: false, message: err ?? 'no data', missing: !!err && isNotFound(err) });
    }
  }
  onResult(keys[0], { ok: false, message: res.message, missing: false });
}

async function splitRun<K>(keys: K[], item: (k: K, alias: string) => GqlItem, onResult: (k: K, r: Outcome<Obj>) => void) {
  const mid = Math.ceil(keys.length / 2);
  await batched(keys.slice(0, mid), item, onResult);
  await batched(keys.slice(mid), item, onResult);
}

// ---- REST ------------------------------------------------------------------

interface RestResult {
  status: number;
  link: string;
  etag?: string;
  body: unknown;
}

const restStats = {
  byStatus: new Map<number, number>(),
  limit: undefined as number | undefined,
  remaining: undefined as number | undefined,
  reset: undefined as number | undefined,
  waited: 0,
};

const header = (head: string, name: string) => new RegExp(`^${name}:\\s*(.*?)\\s*$`, 'im').exec(head)?.[1];

async function restGet(path: string, etag?: string): Promise<RestResult> {
  // Wait for the reset rather than running into the limit (GITHUB_TOKEN has 1,000 an hour).
  if (restStats.remaining !== undefined && restStats.remaining < REST_RESERVE && restStats.reset) {
    const wait = restStats.reset * 1000 - Date.now() + 5000;
    if (wait > 0) {
      progress(`  REST rate limit low (${restStats.remaining} left); waiting ${Math.ceil(wait / 60000)} min for the reset`);
      restStats.waited += wait;
      restStats.remaining = undefined;
      await sleep(wait);
    }
  }
  let out = '';
  const args = ['api', '-i', ...(etag ? ['-H', `If-None-Match: ${etag}`] : []), path];
  try {
    ({ stdout: out } = await execFileAsync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }));
  } catch (e) {
    // gh exits non-zero for 304 and errors, with the response on stdout.
    out = (e as { stdout?: string }).stdout ?? '';
    if (!out.startsWith('HTTP/')) throw e;
  }
  const split = out.search(/\r?\n\r?\n/);
  const head = split < 0 ? out : out.slice(0, split);
  const bodyText = split < 0 ? '' : out.slice(split).trim();
  const status = Number(/^HTTP\/\S+ (\d{3})/.exec(head)?.[1] ?? 0);
  restStats.byStatus.set(status, (restStats.byStatus.get(status) ?? 0) + 1);
  const remaining = header(head, 'x-ratelimit-remaining');
  if (remaining !== undefined && header(head, 'x-ratelimit-resource') !== 'search') {
    restStats.remaining = Number(remaining);
    restStats.limit = Number(header(head, 'x-ratelimit-limit'));
    restStats.reset = Number(header(head, 'x-ratelimit-reset'));
  }
  let body: unknown = undefined;
  try {
    body = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    /* leave undefined */
  }
  return { status, link: header(head, 'link') ?? '', etag: header(head, 'etag'), body };
}

async function restRetry(path: string, etag?: string): Promise<RestResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await restGet(path, etag);
      if (r.status >= 500 && attempt < 2) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      return r;
    } catch (e) {
      if (attempt >= 2) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
}

type ContributorStats = { contributors: number; busFactor: number; contributorsEtag?: string };

/**
 * Contributor count (anonymous included) and bus factor. `unchanged` on a 304 for the
 * stored ETag; undefined when GitHub refuses (huge repos) or the repo is empty.
 */
async function contributorStats(src: GithubSource, commits: number, etag?: string): Promise<ContributorStats | 'unchanged' | undefined> {
  const base = `repos/${src.owner}/${src.repo}/contributors?per_page=100&anon=1`;
  const first = await restRetry(base, etag);
  if (first.status === 304) return 'unchanged';
  if (first.status === 204 || first.status === 403 || first.status === 404 || first.status === 409) return undefined;
  if (first.status !== 200 || !Array.isArray(first.body)) return undefined;
  const page = first.body.map((c) => num(asObj(c)?.contributions)).sort((a, b) => b - a);
  const lastPage = Number(/[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(first.link)?.[1] ?? 1);
  let contributors = page.length;
  if (lastPage > 1) {
    const last = await restRetry(`${base}&page=${lastPage}`);
    const lastLen = last.status === 200 && Array.isArray(last.body) ? last.body.length : 0;
    contributors = 100 * (lastPage - 1) + lastLen;
  }
  const sum = page.reduce((a, b) => a + b, 0);
  const denom = contributors > 100 ? Math.max(sum, commits) : sum;
  let acc = 0;
  let busFactor = 0;
  for (const c of page) {
    acc += c;
    busFactor++;
    if (acc >= denom / 2) break;
  }
  // With more than one page, a 304 on page 1 says nothing about the last page; store no ETag.
  return { contributors, busFactor: page.length ? busFactor : 0, ...(lastPage === 1 && first.etag ? { contributorsEtag: first.etag } : {}) };
}

// ---- main ------------------------------------------------------------------

const USAGE = `Usage: pnpm metrics:fetch (--missing | --full | --only <device-slug>...) [--prune] [--resume] [--publish]`;

async function main() {
  const { values } = parseArgs({
    options: {
      missing: { type: 'boolean' },
      full: { type: 'boolean' },
      only: { type: 'string', multiple: true },
      prune: { type: 'boolean' },
      resume: { type: 'boolean' },
      publish: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return void console.log(USAGE);
  const modes = [values.missing && 'missing', values.full && 'full', values.only?.length && 'only'].filter(Boolean);
  if (modes.length !== 1) {
    console.error(`Pick exactly one of --missing, --full and --only.\n${USAGE}`);
    process.exit(2);
  }
  const mode = modes[0] as 'missing' | 'full' | 'only';

  const started = Date.now();
  const runAt = new Date(started).toISOString();
  const since = new Date(started - 365 * DAY_MS).toISOString();
  const stamp = () => new Date().toISOString();

  // Start from the asset the lock points to; never from a stale stand-in.
  const baseLock = readLock(ROOT);
  let snap: MetricsSnapshot = { fetchedAt: '', repos: {}, paths: {}, missing: {} };
  if (baseLock) {
    const loaded = await loadSnapshotForLock(baseLock, ROOT, { skipRemote: false });
    if (!loaded || loaded.from === 'stale-cache') throw new Error(`Could not load ${baseLock.asset}, which ${LOCK_FILE} points to`);
    snap = loaded.snapshot;
    progress(`Starting from ${baseLock.asset} (${baseLock.repos} repos, ${loaded.from})`);
  } else progress(`No ${LOCK_FILE}; starting an empty snapshot`);
  const baseText = serializeSnapshot(snap);
  // Records from before per-repo times were all fetched at the snapshot's time.
  const recordAt = (r: { fetchedAt?: string } | undefined) => r?.fetchedAt ?? snap.fetchedAt;
  const historyAt = (r: { historyAt?: string; fetchedAt?: string } | undefined) => r?.historyAt ?? recordAt(r);

  const { sources, skipped } = readEntries();
  const workshop = await workshopSources();
  // Loader-generated cards join the device's own YAML entries.
  if (workshop) sources.set(WORKSHOP_DEVICE, [...(sources.get(WORKSHOP_DEVICE) ?? []), ...workshop]);
  const only = values.only?.length ? new Set(values.only) : undefined;
  if (only) for (const d of only) if (!sources.has(d)) console.error(`No entries with a GitHub source for device "${d}"`);

  const allRepos = new Map<string, GithubSource>();
  const allPaths = new Map<string, GithubSource>();
  for (const [device, list] of sources) {
    for (const src of list) {
      if (only && !only.has(device)) continue;
      if (!allRepos.has(src.key)) allRepos.set(src.key, src);
      if (src.pathKey && !allPaths.has(src.pathKey)) allPaths.set(src.pathKey, src);
    }
  }
  const referencedRepos = new Set<string>();
  const referencedPaths = new Set<string>();
  for (const list of sources.values()) for (const s of list) (referencedRepos.add(s.key), s.pathKey && referencedPaths.add(s.pathKey));

  const fresh = (r: { fetchedAt?: string } | undefined) => !!values.resume && !!r && started - Date.parse(recordAt(r)) < RESUME_MS;
  let repoTargets = [...allRepos.values()];
  if (mode === 'missing') repoTargets = repoTargets.filter((s) => !snap.repos[s.key] && !(s.key in snap.missing));
  repoTargets = repoTargets.filter((s) => !fresh(snap.repos[s.key]));
  progress(`${mode}: ${repoTargets.length} of ${allRepos.size} repos to check (${skipped} entries have no GitHub source)`);

  const failed: string[] = [];
  const counts = { full: 0, light: 0, refreshed: 0, skipped: 0, missing: 0, contributors304: 0 };
  /** Repos whose history was refetched in this run (their paths follow). */
  const historyDone = new Set<string>();
  /** Repos confirmed unchanged by the light query (their paths are current too). */
  const confirmed = new Set<string>();

  // Checkpoints: write a content-addressed asset and point the lock at it, so an
  // interrupted run leaves a valid snapshot (finish it with --resume).
  let lastWritten: MetricsLock | undefined;
  let sinceCheckpoint = 0;
  const checkpoint = () => {
    const lock = storeSnapshot(ROOT, snap);
    if (lastWritten && lastWritten.asset !== lock.asset && lastWritten.asset !== baseLock?.asset) rmSync(cachePath(ROOT, lastWritten.asset), { force: true });
    writeLock(ROOT, lock);
    lastWritten = lock;
    sinceCheckpoint = 0;
  };
  const tick = (n: number) => {
    sinceCheckpoint += n;
    if (sinceCheckpoint >= CHECKPOINT_EVERY) checkpoint();
  };

  const markMissing = (s: GithubSource, message: string) => {
    snap.missing[s.key] = message;
    delete snap.repos[s.key];
    counts.missing++;
  };

  // ---- full fetch: light + history + forks + contributors ----
  async function fetchFull(list: GithubSource[]) {
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      const got = new Map<string, RawRepo>();
      await batched(
        chunk,
        (s, alias) => ({ alias, vars: { o: s.owner, n: s.repo }, field: repoQuery(`${LIGHT_FIELDS}\n  ${heavyFields(since)}`) }),
        (s, r) => {
          if (r.ok) got.set(s.key, mapRepo(r.value, stamp()));
          else if (r.missing) markMissing(s, r.message);
          else failed.push(`${s.key}: ${r.message}`);
        },
      );

      // Forks: commits and authors since the fork was created (the rest is the parent's history).
      const forkSrcs = chunk.filter((s) => got.get(s.key)?.metrics.parent);
      if (forkSrcs.length) {
        await batched(
          forkSrcs,
          (s, alias) => ({
            alias,
            vars: { o: s.owner, n: s.repo },
            field: (v) => `repository(owner: ${v('o')}, name: ${v('n')}) { defaultBranchRef { target { ... on Commit {
            own: history(since: "${got.get(s.key)!.metrics.createdAt}", first: 100) { totalCount nodes { author { email user { login } } } }
          } } } }`,
          }),
          (s, r) => {
            const m = got.get(s.key)!.metrics;
            if (!r.ok) return void failed.push(`${s.key} (own commits): ${r.message}`);
            const own = asObj(asObj(asObj(r.value.defaultBranchRef)?.target)?.own);
            const authors = new Set<string>();
            for (const n of arr(own?.nodes)) {
              const a = asObj(asObj(n)?.author);
              const id = str(asObj(a?.user)?.login) || str(a?.email).toLowerCase();
              if (id) authors.add(id);
            }
            m.ownCommits = total(own);
            m.ownAuthors = authors.size;
          },
        );
      }

      // Contributors (REST, conditional on the stored ETag), modest concurrency.
      const entries = [...got.entries()];
      await Promise.all(
        Array.from({ length: Math.min(REST_CONCURRENCY, entries.length) }, async (_, w) => {
          for (let j = w; j < entries.length; j += REST_CONCURRENCY) {
            const [key, raw] = entries[j];
            const prev = snap.repos[key];
            const src = allRepos.get(key)!;
            try {
              const c = await contributorStats(src, raw.metrics.commits, prev?.contributorsEtag);
              if (c === 'unchanged') {
                counts.contributors304++;
                Object.assign(raw.metrics, { contributors: prev!.contributors, busFactor: prev!.busFactor, contributorsEtag: prev!.contributorsEtag });
              } else if (c) Object.assign(raw.metrics, c);
              else raw.metrics.contributors = raw.mentionable;
            } catch (e) {
              raw.metrics.contributors = raw.mentionable;
              failed.push(`${key} (contributors): ${(e as Error).message.split('\n')[0]}`);
            }
          }
        }),
      );

      for (const [key, raw] of got) {
        snap.repos[key] = raw.metrics;
        delete snap.missing[key];
        historyDone.add(key);
        counts.full++;
      }
      progress(`  full ${Math.min(i + BATCH, list.length)}/${list.length} (missing ${counts.missing}, GraphQL left ${gqlStats.remaining ?? '?'}, REST left ${restStats.remaining ?? '?'})`);
      tick(chunk.length);
    }
  }

  // ---- --full: light check, then history only where it changed ----
  async function fetchLight(list: GithubSource[]): Promise<{ changed: GithubSource[]; stale: GithubSource[] }> {
    const changed: GithubSource[] = [];
    const stale: GithubSource[] = [];
    let done = 0;
    // A few light batches at a time: each is cheap, and they share nothing but the snapshot.
    await pool(chunks(list, LIGHT_BATCH), LIGHT_CONCURRENCY, async (chunk) => {
      await batched(
        chunk,
        (s, alias) => ({ alias, vars: { o: s.owner, n: s.repo }, field: repoQuery(LIGHT_FIELDS) }),
        (s, r) => {
          if (!r.ok) {
            if (r.missing) markMissing(s, r.message);
            else failed.push(`${s.key} (light): ${r.message}`);
            return;
          }
          const prev = snap.repos[s.key];
          const light = mapLight(r.value, stamp());
          counts.light++;
          if (!prev || prev.pushedAt !== light.pushedAt) return void changed.push(s);
          // Unchanged: take the new counts, keep history, forks and contributors.
          // historyAt first: once fetchedAt moves on, it no longer says when the history was fetched.
          const next: RepoMetrics = { ...prev, ...light, historyAt: historyAt(prev) };
          if (!light.parent) delete next.parent;
          snap.repos[s.key] = next;
          delete snap.missing[s.key];
          confirmed.add(s.key);
          const ageDays = (started - Date.parse(historyAt(prev))) / DAY_MS;
          if ((prev.commitsLastYear > 0 && ageDays > HISTORY_MAX_AGE_DAYS) || prev.forks !== light.forks) stale.push(s);
          else counts.skipped++;
        },
      );
      done += chunk.length;
      progress(`  light ${done}/${list.length} (changed ${changed.length}, refresh ${stale.length}, GraphQL left ${gqlStats.remaining ?? '?'})`);
      tick(chunk.length);
    });
    return { changed, stale };
  }

  /** Unchanged repos: recount last-year commits and relist forks (no contributors). */
  async function refreshHistory(list: GithubSource[]) {
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      await batched(
        chunk,
        (s, alias) => ({
          alias,
          vars: { o: s.owner, n: s.repo },
          field: repoQuery(`defaultBranchRef { target { ... on Commit { yr: history(since: "${since}") { totalCount } } } }\n  ${FORKS_FIELD}`),
        }),
        (s, r) => {
          if (!r.ok) return void failed.push(`${s.key} (history refresh): ${r.message}`);
          const m = snap.repos[s.key];
          m.commitsLastYear = total(asObj(asObj(asObj(r.value.defaultBranchRef)?.target)?.yr));
          m.topForks = mapForks(r.value);
          m.historyAt = stamp();
          historyDone.add(s.key);
          counts.refreshed++;
        },
      );
      progress(`  refresh ${Math.min(i + BATCH, list.length)}/${list.length}`);
      tick(chunk.length);
    }
  }

  if (mode === 'full') {
    const { changed, stale } = await fetchLight(repoTargets);
    progress(`Light check: ${changed.length} changed or new, ${stale.length} to refresh, ${counts.skipped} unchanged`);
    await fetchFull(changed);
    await refreshHistory(stale);
  } else {
    await fetchFull(repoTargets);
  }

  // ---- paths (monorepo subdirectories), for repos that resolved ----
  let pathTargets = [...allPaths.values()].filter((s) => snap.repos[s.key] && !fresh(snap.paths[s.pathKey!]));
  if (mode === 'missing') pathTargets = pathTargets.filter((s) => !snap.paths[s.pathKey!]);
  if (mode === 'full') {
    pathTargets = pathTargets.filter((s) => {
      const p = snap.paths[s.pathKey!];
      if (!p || historyDone.has(s.key)) return true;
      if (!confirmed.has(s.key)) return false; // the light check failed; leave it
      const stale = p.commitsLastYear > 0 && (started - Date.parse(historyAt(p))) / DAY_MS > HISTORY_MAX_AGE_DAYS;
      if (!stale) {
        // The repo is unchanged, so the path is too.
        p.historyAt = historyAt(p);
        p.fetchedAt = snap.repos[s.key].fetchedAt;
      }
      return stale;
    });
  }

  let pathsOk = 0;
  // A tree URL cannot tell a branch with slashes (feature/x) from branch + path, so the
  // parser takes the first segment as the branch. When that branch does not exist, move
  // one path segment into the branch name and try again; an empty path means the whole
  // URL named a branch, and its history is counted without a path filter.
  type PathSpec = GithubSource & { tryBranch?: string; tryPath?: string };
  let pathable: PathSpec[] = pathTargets;
  const total0 = pathable.length;
  for (let round = 0; round < 4 && pathable.length; round++) {
    const retry: PathSpec[] = [];
    for (let i = 0; i < pathable.length; i += PATH_BATCH) {
      const chunk = pathable.slice(i, i + PATH_BATCH);
      await batched(
        chunk,
        (s, alias) => {
          const p = s.tryPath ?? decodeURIComponent(s.path!);
          // history(...) arguments, with the path filter only when there is a path.
          const h = (...more: string[]) => {
            const a = [...(p ? [`path: ${JSON.stringify(p)}`] : []), ...more];
            return a.length ? `(${a.join(', ')})` : '';
          };
          return {
            alias,
            vars: { o: s.owner, n: s.repo, b: s.tryBranch ?? s.branch ?? 'HEAD' },
            field: (v) => `repository(owner: ${v('o')}, name: ${v('n')}) { object(expression: ${v('b')}) { ... on Commit {
            all: history${h()} { totalCount }
            yr: history${h(`since: "${since}"`)} { totalCount }
            last: history${h('first: 1')} { nodes { committedDate } }
          } } }`,
          };
        },
        (s, r) => {
          if (!r.ok) return void failed.push(`${s.pathKey}: ${r.message}`);
          const o = asObj(r.value.object);
          if (!o) {
            const p = s.tryPath ?? decodeURIComponent(s.path!);
            if (p) {
              const [head, ...rest] = p.split('/');
              retry.push({ ...s, tryBranch: `${s.tryBranch ?? s.branch ?? 'HEAD'}/${head}`, tryPath: rest.join('/') });
              return;
            }
            return void failed.push(`${s.pathKey}: branch "${s.branch ?? 'HEAD'}" not found`);
          }
          const at = stamp();
          const pm: PathMetrics = {
            fetchedAt: at,
            historyAt: at,
            commits: total(o.all),
            commitsLastYear: total(o.yr),
            lastCommit: iso(firstNode(o.last)?.committedDate),
          };
          snap.paths[s.pathKey!] = pm;
          pathsOk++;
        },
      );
      progress(`  paths ${Math.min(i + PATH_BATCH, pathable.length)}/${pathable.length}${round ? ` (slash-branch retry ${round})` : ''}`);
    }
    pathable = retry;
  }
  for (const s of pathable) failed.push(`${s.pathKey}: no branch found for this tree URL`);

  if (values.prune) {
    const keepWorkshop = !workshop;
    const isWorkshop = (k: string) => k.startsWith(WORKSHOP_REPO.toLowerCase());
    let pruned = 0;
    for (const k of Object.keys(snap.repos)) if (!referencedRepos.has(k) && !(keepWorkshop && isWorkshop(k))) (delete snap.repos[k], pruned++);
    for (const k of Object.keys(snap.missing)) if (!referencedRepos.has(k)) (delete snap.missing[k], pruned++);
    for (const k of Object.keys(snap.paths)) if (!referencedPaths.has(k) && !(keepWorkshop && isWorkshop(k))) (delete snap.paths[k], pruned++);
    progress(`Pruned ${pruned} unreferenced keys`);
  }

  // The snapshot date is the last full refresh; top-ups keep it (each record has its own).
  if (mode === 'full') snap.fetchedAt = runAt;
  else if (!snap.fetchedAt) snap.fetchedAt = runAt;

  let lock: MetricsLock | null = baseLock;
  if (serializeSnapshot(snap) === baseText) {
    if (lastWritten && lastWritten.asset !== baseLock?.asset) rmSync(cachePath(ROOT, lastWritten.asset), { force: true });
    if (baseLock) writeLock(ROOT, baseLock);
    progress(`No changes; ${LOCK_FILE} still points to ${baseLock?.asset ?? 'nothing'}`);
  } else {
    checkpoint();
    lock = lastWritten!;
  }

  const secs = Math.round((Date.now() - started) / 1000);
  const by = (s: number) => restStats.byStatus.get(s) ?? 0;
  const restTotal = [...restStats.byStatus.values()].reduce((a, b) => a + b, 0);
  const restCounted = restTotal - by(304);
  const status = [...restStats.byStatus.entries()].sort(([a], [b]) => a - b).map(([s, n]) => `${s}: ${n}`).join(', ');
  console.log(
    `\n${mode}: repos full ${counts.full}, light-only ${counts.skipped}, history refresh ${counts.refreshed}, missing ${counts.missing}; ` +
      `paths ${pathsOk}/${total0}; failed ${failed.length}\n` +
      `contributors: ${counts.contributors304} unchanged (304)\n` +
      `REST: ${restTotal} requests (${status || 'none'}); ${restCounted} counted against the limit` +
      `${restStats.limit ? `, ${restStats.remaining} of ${restStats.limit} left` : ''}` +
      `${restStats.waited ? `, waited ${Math.round(restStats.waited / 60000)} min for resets` : ''}\n` +
      `GraphQL: ${gqlStats.requests} requests, cost ${gqlStats.cost} points${gqlStats.limit ? `, ${gqlStats.remaining} of ${gqlStats.limit} left` : ''}, batch splits ${gqlStats.splits}\n` +
      `Actions GITHUB_TOKEN budget (${ACTIONS_REST_BUDGET} REST and ${ACTIONS_REST_BUDGET} GraphQL points an hour): ` +
      `${restCounted <= ACTIONS_REST_BUDGET && gqlStats.cost <= ACTIONS_REST_BUDGET ? 'fits' : 'does not fit in one hour'}\n` +
      `elapsed: ${Math.floor(secs / 60)}m${secs % 60}s\n` +
      `snapshot: ${Object.keys(snap.repos).length} repos, ${Object.keys(snap.paths).length} paths, ${Object.keys(snap.missing).length} missing -> ${lock?.asset ?? 'none'}`,
  );
  for (const f of failed.slice(0, 30)) console.log(`  FAILED ${f}`);
  if (failed.length > 30) console.log(`  … and ${failed.length - 30} more`);

  if (values.publish && lock) await publish(ROOT, lock);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
