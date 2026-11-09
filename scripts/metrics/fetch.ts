/**
 * Fetches GitHub signals for every firmware entry's `source` repo and writes
 * the committed snapshot src/data/repo-metrics.json (shape: src/lib/repo-metrics.ts).
 * Raw signals only; scores are computed at build time.
 *
 *   pnpm metrics:fetch                       full run (merges into the existing snapshot)
 *   pnpm metrics:fetch --only <device-slug>  only that device's entries (repeatable)
 *   pnpm metrics:fetch --resume              skip repos fetched in the last 24 hours
 *   pnpm metrics:fetch --prune               drop repo/path keys no entry references any more
 *
 * Uses the `gh` CLI (GraphQL in aliased batches, REST for contributors).
 * Per-repo fetch times for --resume live in node_modules/.cache/metrics-fetch-progress.json.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { parse } from 'yaml';
import {
  parseGithubSource,
  METRICS_FILE,
  type ForkMetrics,
  type GithubSource,
  type MetricsSnapshot,
  type PathMetrics,
  type RepoMetrics,
} from '../../src/lib/repo-metrics.ts';
import { arr, asObj, gh, graphql, progress, sleep, str, type GqlItem, type Obj } from '../lib/github.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = join(ROOT, METRICS_FILE);
const PROGRESS_FILE = join(ROOT, 'node_modules/.cache/metrics-fetch-progress.json');
const FIRMWARES = join(ROOT, 'src/content/firmwares');

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 10;
const PATH_BATCH = 20;
const REST_CONCURRENCY = 6;
const CHECKPOINT_EVERY = 200;
const RESUME_MS = DAY_MS;
const execFileAsync = promisify(execFile);

const WORKSHOP_DEVICE = 'music-thing-workshop-computer';
const WORKSHOP_REPO = 'TomWhitwell/Workshop_Computer';
const WORKSHOP_BRANCH = 'main';

// ---- entries ---------------------------------------------------------------

interface Target {
  src: GithubSource;
  devices: Set<string>;
}

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

/** The generated Workshop Computer cards: every directory of releases/ upstream, as the loader lists them. */
async function workshopSources(): Promise<GithubSource[] | undefined> {
  const r = gh([`repos/${WORKSHOP_REPO}/contents/releases?ref=${WORKSHOP_BRANCH}`]);
  if (!r.ok || !Array.isArray(r.json)) {
    progress(`Workshop Computer card listing failed (${r.ok ? 'unexpected shape' : r.message}); skipping its cards`);
    return undefined;
  }
  const out: GithubSource[] = [];
  for (const e of r.json) {
    const o = asObj(e);
    if (o?.type !== 'dir' || typeof o.name !== 'string') continue;
    const src = parseGithubSource(
      `https://github.com/${WORKSHOP_REPO}/tree/${WORKSHOP_BRANCH}/releases/${encodeURIComponent(o.name)}`,
    );
    if (src) out.push(src);
  }
  return out;
}

// ---- GraphQL ---------------------------------------------------------------

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const total = (v: unknown): number => num(asObj(v)?.totalCount);
const iso = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const firstNode = (v: unknown): Obj | undefined => asObj(arr(asObj(v)?.nodes)[0]);

const RATE_LIMIT_ITEM: GqlItem = { alias: 'rl', vars: {}, field: () => 'rateLimit { cost remaining resetAt }' };

interface RateInfo {
  remaining?: number;
  cost: number;
}
const rate: RateInfo = { cost: 0 };

function noteRate(data: Obj) {
  const rl = asObj(data.rl);
  if (!rl) return;
  rate.remaining = num(rl.remaining);
  rate.cost += num(rl.cost);
}

const repoField = (since: string) => (v: (k: string) => string) => `repository(owner: ${v('o')}, name: ${v('n')}) {
  nameWithOwner createdAt pushedAt isArchived parent { nameWithOwner }
  stargazerCount forkCount watchers { totalCount }
  releases { totalCount }
  recent: releases(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { publishedAt createdAt tagName isPrerelease } }
  oldest: releases(first: 1, orderBy: {field: CREATED_AT, direction: ASC}) { nodes { publishedAt createdAt } }
  defaultBranchRef { target { ... on Commit {
    all: history { totalCount }
    yr: history(since: "${since}") { totalCount }
    last: history(first: 1) { nodes { committedDate } }
  } } }
  hasIssuesEnabled
  open: issues(states: OPEN) { totalCount }
  closed: issues(states: CLOSED) { totalCount }
  prs: pullRequests { totalCount }
  merged: pullRequests(states: MERGED) { totalCount }
  hasDiscussionsEnabled
  discussions { totalCount }
  mentionableUsers { totalCount }
  forks(first: 100, orderBy: {field: STARGAZERS, direction: DESC}) { nodes { nameWithOwner stargazerCount createdAt pushedAt } }
}`;

const STABLE_TAG = /^v?([1-9]\d*)\.\d+/;
const PRE_TAG = /[-_.](alpha|beta|rc)(?![a-z])/i;

type RawRepo = { metrics: RepoMetrics; mentionable: number };

function mapRepo(r: Obj): RawRepo {
  const stars = num(r.stargazerCount);
  const recent = arr(asObj(r.recent)?.nodes).map((n) => asObj(n)!);
  const newest = recent[0];
  const newestStable = recent.find((n) => n.isPrerelease !== true);
  const oldest = firstNode(r.oldest);
  const target = asObj(asObj(r.defaultBranchRef)?.target);
  const parent = str(asObj(r.parent)?.nameWithOwner);
  const forks: ForkMetrics[] = arr(asObj(r.forks)?.nodes)
    .map((n) => asObj(n))
    .filter((n): n is Obj => !!n)
    .map((n) => ({
      name: str(n.nameWithOwner),
      stars: num(n.stargazerCount),
      createdAt: str(n.createdAt),
      pushedAt: str(n.pushedAt),
    }));
  const tag = typeof newestStable?.tagName === 'string' ? newestStable.tagName : '';
  const m: RepoMetrics = {
    name: str(r.nameWithOwner),
    createdAt: str(r.createdAt),
    pushedAt: str(r.pushedAt),
    archived: r.isArchived === true,
    ...(parent ? { parent } : {}),
    stars,
    forks: num(r.forkCount),
    watchers: total(r.watchers),
    releases: total(r.releases),
    latestRelease: iso(newest?.publishedAt) ?? iso(newest?.createdAt),
    firstRelease: iso(oldest?.publishedAt) ?? iso(oldest?.createdAt),
    stableRelease: STABLE_TAG.test(tag) && !PRE_TAG.test(tag),
    commits: total(target?.all),
    commitsLastYear: total(target?.yr),
    lastCommit: iso(firstNode(target?.last)?.committedDate),
    hasIssues: r.hasIssuesEnabled === true,
    issuesOpen: total(r.open),
    issuesClosed: total(r.closed),
    prsMerged: total(r.merged),
    prsTotal: total(r.prs),
    hasDiscussions: r.hasDiscussionsEnabled === true,
    discussions: total(r.discussions),
    contributors: 0,
    busFactor: 0,
    topForks: forks,
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
async function batched<K>(
  keys: K[],
  item: (k: K, alias: string) => GqlItem,
  onResult: (k: K, r: Outcome<Obj>) => void,
  stats: { splits: number },
): Promise<void> {
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
      stats.splits++;
      await splitRun(retry, item, onResult, stats);
    }
    return;
  }
  if (keys.length > 1) {
    stats.splits++;
    return splitRun(keys, item, onResult, stats);
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

async function splitRun<K>(
  keys: K[],
  item: (k: K, alias: string) => GqlItem,
  onResult: (k: K, r: Outcome<Obj>) => void,
  stats: { splits: number },
) {
  const mid = Math.ceil(keys.length / 2);
  await batched(keys.slice(0, mid), item, onResult, stats);
  await batched(keys.slice(mid), item, onResult, stats);
}

// ---- REST: contributors ------------------------------------------------------

interface RestResult {
  status: number;
  link: string;
  body: unknown;
}

async function restGet(path: string): Promise<RestResult> {
  let out = '';
  try {
    ({ stdout: out } = await execFileAsync('gh', ['api', '-i', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }));
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? '';
    if (!out.startsWith('HTTP/')) throw e;
  }
  const split = out.search(/\r?\n\r?\n/);
  const head = split < 0 ? out : out.slice(0, split);
  const bodyText = split < 0 ? '' : out.slice(split).trim();
  const status = Number(/^HTTP\/\S+ (\d{3})/.exec(head)?.[1] ?? 0);
  const link = /^link:\s*(.*)$/im.exec(head)?.[1] ?? '';
  let body: unknown = undefined;
  try {
    body = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    /* leave undefined */
  }
  return { status, link, body };
}

async function restRetry(path: string): Promise<RestResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await restGet(path);
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

/** Contributor count (anonymous included) and bus factor, or undefined when GitHub refuses (huge repos) or the repo is empty. */
async function contributorStats(src: GithubSource, commits: number): Promise<{ contributors: number; busFactor: number } | undefined> {
  const base = `repos/${src.owner}/${src.repo}/contributors?per_page=100&anon=1`;
  const first = await restRetry(base);
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
  return { contributors, busFactor: page.length ? busFactor : 0 };
}

// ---- snapshot --------------------------------------------------------------

function loadSnapshot(): MetricsSnapshot {
  if (existsSync(OUT)) {
    const s = JSON.parse(readFileSync(OUT, 'utf8')) as MetricsSnapshot;
    return { fetchedAt: s.fetchedAt, repos: s.repos ?? {}, paths: s.paths ?? {}, missing: s.missing ?? {} };
  }
  return { fetchedAt: '', repos: {}, paths: {}, missing: {} };
}

const sortKeys = <T>(o: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function writeSnapshot(s: MetricsSnapshot) {
  const out: MetricsSnapshot = {
    fetchedAt: s.fetchedAt,
    repos: sortKeys(s.repos),
    paths: sortKeys(s.paths),
    missing: sortKeys(s.missing),
  };
  mkdirSync(dirname(OUT), { recursive: true });
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  renameSync(tmp, OUT);
}

function loadProgress(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveProgress(p: Record<string, string>) {
  mkdirSync(dirname(PROGRESS_FILE), { recursive: true });
  writeFileSync(PROGRESS_FILE, JSON.stringify(p));
}

// ---- main ------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      only: { type: 'string', multiple: true },
      prune: { type: 'boolean' },
      resume: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    console.log('Usage: pnpm metrics:fetch [--only <device-slug>]... [--resume] [--prune]');
    return;
  }
  const started = Date.now();
  const fetchedAt = new Date(started).toISOString();
  const since = new Date(started - 365 * DAY_MS).toISOString();

  const { sources, skipped } = readEntries();
  const workshop = await workshopSources();
  // Loader-generated cards join the device's own YAML entries.
  if (workshop) sources.set(WORKSHOP_DEVICE, [...(sources.get(WORKSHOP_DEVICE) ?? []), ...workshop]);
  const only = values.only?.length ? new Set(values.only) : undefined;
  if (only) {
    for (const d of only) if (!sources.has(d)) console.error(`No entries with a GitHub source for device "${d}"`);
  }

  const repoTargets = new Map<string, GithubSource>();
  const pathTargets = new Map<string, GithubSource>();
  const referencedRepos = new Set<string>();
  const referencedPaths = new Set<string>();
  for (const [device, list] of sources) {
    for (const src of list) {
      referencedRepos.add(src.key);
      if (src.pathKey) referencedPaths.add(src.pathKey);
      if (only && !only.has(device)) continue;
      if (!repoTargets.has(src.key)) repoTargets.set(src.key, src);
      if (src.pathKey && !pathTargets.has(src.pathKey)) pathTargets.set(src.pathKey, src);
    }
  }
  progress(`${repoTargets.size} repos, ${pathTargets.size} paths to fetch (${skipped} entries have no GitHub source)`);

  const snap = loadSnapshot();
  const prog = loadProgress();
  snap.fetchedAt = fetchedAt;
  const fresh = (k: string) => values.resume && prog[k] && started - Date.parse(prog[k]) < RESUME_MS;
  const todo = [...repoTargets.values()].filter((s) => !(fresh(s.key) && snap.repos[s.key]));
  const todoPaths = [...pathTargets.values()].filter((s) => !(fresh(s.pathKey!) && snap.paths[s.pathKey!]));
  if (values.resume) progress(`Resuming: ${repoTargets.size - todo.length} repos and ${pathTargets.size - todoPaths.length} paths are fresh`);

  const stats = { splits: 0 };
  let ok = 0;
  let missing = 0;
  const failed: string[] = [];
  let sinceCheckpoint = 0;
  const checkpoint = () => {
    writeSnapshot(snap);
    saveProgress(prog);
    sinceCheckpoint = 0;
  };

  const repoItem = (s: GithubSource, alias: string): GqlItem => ({
    alias,
    vars: { o: s.owner, n: s.repo },
    field: (v) => repoField(since)(v),
  });

  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const got = new Map<string, RawRepo>();
    await batched(
      chunk,
      repoItem,
      (s, r) => {
        if (r.ok) got.set(s.key, mapRepo(r.value));
        else if (r.missing) {
          snap.missing[s.key] = r.message;
          delete snap.repos[s.key];
          prog[s.key] = new Date().toISOString();
          missing++;
        } else failed.push(`${s.key}: ${r.message}`);
      },
      stats,
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
            const login = str(asObj(a?.user)?.login);
            const email = str(a?.email).toLowerCase();
            const id = login || email;
            if (id) authors.add(id);
          }
          m.ownCommits = total(own);
          m.ownAuthors = authors.size;
        },
        stats,
      );
    }

    // Contributors (REST), modest concurrency.
    const list = [...got.entries()];
    await Promise.all(
      Array.from({ length: Math.min(REST_CONCURRENCY, list.length) }, async (_, w) => {
        for (let j = w; j < list.length; j += REST_CONCURRENCY) {
          const [key, raw] = list[j];
          const src = repoTargets.get(key)!;
          try {
            const c = await contributorStats(src, raw.metrics.commits);
            if (c) Object.assign(raw.metrics, c);
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
      prog[key] = new Date().toISOString();
      ok++;
    }
    sinceCheckpoint += chunk.length;
    progress(`  repos ${Math.min(i + BATCH, todo.length)}/${todo.length} (ok ${ok}, missing ${missing}, rate remaining ${rate.remaining ?? '?'})`);
    if (sinceCheckpoint >= CHECKPOINT_EVERY) checkpoint();
  }
  checkpoint();

  // Paths (monorepo subdirectories), for repos that resolved.
  let pathsOk = 0;
  // A tree URL cannot tell a branch with slashes (feature/x) from branch + path, so the
  // parser takes the first segment as the branch. When that branch does not exist, move
  // one path segment into the branch name and try again; an empty path means the whole
  // URL named a branch, and its history is counted without a path filter.
  type PathSpec = (typeof todoPaths)[number] & { tryBranch?: string; tryPath?: string };
  let pathable: PathSpec[] = todoPaths.filter((s) => !snap.missing[s.key]);
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
        const pm: PathMetrics = {
          commits: total(o.all),
          commitsLastYear: total(o.yr),
          lastCommit: iso(firstNode(o.last)?.committedDate),
        };
        snap.paths[s.pathKey!] = pm;
        prog[s.pathKey!] = new Date().toISOString();
        pathsOk++;
      },
      stats,
    );
    progress(`  paths ${Math.min(i + PATH_BATCH, pathable.length)}/${pathable.length}${round ? ` (slash-branch retry ${round})` : ''}`);
    }
    pathable = retry;
  }
  for (const s of pathable) failed.push(`${s.pathKey}: no branch found for this tree URL`);

  if (values.prune) {
    const keepWorkshop = !workshop;
    const isWorkshop = (k: string) => k.startsWith(`${WORKSHOP_REPO.toLowerCase()}`);
    let pruned = 0;
    for (const k of Object.keys(snap.repos)) if (!referencedRepos.has(k) && !(keepWorkshop && isWorkshop(k))) (delete snap.repos[k], pruned++);
    for (const k of Object.keys(snap.missing)) if (!referencedRepos.has(k)) (delete snap.missing[k], pruned++);
    for (const k of Object.keys(snap.paths)) if (!referencedPaths.has(k) && !(keepWorkshop && isWorkshop(k))) (delete snap.paths[k], pruned++);
    progress(`Pruned ${pruned} unreferenced keys`);
  }
  checkpoint();

  const secs = Math.round((Date.now() - started) / 1000);
  console.log(
    `\nrepos ok: ${ok}, missing: ${missing}, paths ok: ${pathsOk}/${total0}, failed: ${failed.length}, batch splits: ${stats.splits}\n` +
      `elapsed: ${Math.floor(secs / 60)}m${secs % 60}s, GraphQL cost: ${rate.cost}, rateLimit remaining: ${rate.remaining ?? '?'}\n` +
      `snapshot: ${Object.keys(snap.repos).length} repos, ${Object.keys(snap.paths).length} paths, ${Object.keys(snap.missing).length} missing -> ${METRICS_FILE}`,
  );
  for (const f of failed.slice(0, 30)) console.log(`  FAILED ${f}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
