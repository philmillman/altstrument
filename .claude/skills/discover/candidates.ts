/**
 * Candidate gatherer for the /discover skill (.claude/skills/discover/).
 *
 * Looks for firmware that might belong in the catalog but is not there yet.
 * It never edits the catalog; it only reports. The /discover skill runs this
 * script, then reviews the output with the maintainer.
 *
 * Sources (all configured in config.yaml next to this file):
 *
 *   - news: RSS/Atom feeds, filtered by keyword or by a catalog device name
 *   - GitHub: repository searches (generic queries plus one per catalog device),
 *     minus every repo the catalog already links to or the maintainer ignored
 *   - prior art: recent commits to other firmware lists (awesome-lists etc.)
 *   - release sweep: GitHub releases, branch heads or tags of catalogued entries
 *     that are newer than the entry's top version (updates, not new entries)
 *
 * GitHub is reached through the `gh` CLI, so there is no token plumbing; it
 * must be installed and authenticated. Repository searches are batched into GraphQL
 * requests (REST search is capped at 30 a minute and trips a secondary limit even
 * below that); a rate limit waits about a minute and retries, and a search GitHub
 * answers with fewer repositories than it counted is asked again.
 *
 * The full report is always written as JSON to --out (default
 * discover-candidates.json in the repo root, which is gitignored). stdout gets a
 * markdown summary, or the JSON with --json. Progress goes to stderr.
 *
 * Exit code 0 on success even with problems; 1 on a config error or when every
 * network source failed; 2 on bad command-line usage.
 */
import { execFile, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { XMLParser } from 'fast-xml-parser';
import { parse } from 'yaml';
import { z } from 'astro/zod';

const ROOT = new URL('../../../', import.meta.url).pathname;
const DEFAULT_CONFIG = new URL('./config.yaml', import.meta.url).pathname;
const DEFAULT_OUT = join(ROOT, 'discover-candidates.json');
const CATALOG_DIRS = ['src/content/devices', 'src/content/firmwares', 'src/content/manufacturers'].map((d) =>
  join(ROOT, d),
);

const DAY_MS = 24 * 60 * 60 * 1000;
const FEED_CONCURRENCY = 4;
const FEED_TIMEOUT_MS = 20_000;
const SAME_HOST_DELAY_MS = 2000;
const MAX_RATE_WAIT_S = 60;
const SEARCH_DELAY_MS = 1000;
const SEARCH_BATCH = 10;
// Searches go out SEARCH_BATCH at a time in one GraphQL request. If GitHub still answers
// with a rate limit (it lasts about a minute and gh does not expose retry-after), wait and retry.
const SEARCH_RATE_WAIT_MS = 70_000;
const SEARCH_RATE_RETRIES = 4;
const SEARCH_INCOMPLETE_RETRIES = 3;
const SWEEP_BATCH = 20;
const SUMMARY_MAX = 400;
const DESCRIPTION_MAX = 120;
const SWEEP_CONCURRENCY = 6;
/** Newer releases listed per entry; the rest are counted. */
const SWEEP_HITS_MAX = 5;
/** Repos whose releases cover many unrelated entries (PortMaster-New ships every port at once). */
const SWEEP_SKIP_REPOS = new Set(['portsmaster/portmaster-new']);

// ---- types -----------------------------------------------------------------

interface NewsCandidate {
  source: string;
  title: string;
  link: string;
  date?: string;
  summary: string;
  /** Keywords and device names that hit. Empty for prefiltered feeds. */
  matched: string[];
  /** Catalog firmware names, repos or hosts the item mentions. */
  knownMentions: string[];
}

interface DeviceGuess {
  slug: string;
  matched: string;
}

interface RepoCandidate {
  repo: string;
  url: string;
  description: string;
  stars: number;
  pushed: string;
  license?: string;
  topics: string[];
  queries: string[];
  deviceGuess: DeviceGuess[];
}

interface CommitCandidate {
  repo: string;
  sha7: string;
  date: string;
  subject: string;
  url: string;
}

interface ReleaseHit {
  kind: 'release' | 'commit' | 'tag';
  /** Tag name, or `<branch> @ <sha7>` for a moved branch. */
  ref: string;
  date?: string;
  url: string;
  prerelease?: boolean;
  /** Tag prefix (e.g. "smk") that none of the entry's versions use: maybe another component's release. */
  otherComponent?: string;
  /** The file names this version outside versions[], often a note that it was left out on purpose. */
  mentioned?: boolean;
}

interface StaleEntry {
  /** Repo-relative path of the firmware file. */
  file: string;
  name: string;
  device: string;
  repo: string;
  top?: { version: string; date?: string };
  hits: ReleaseHit[];
  /** Newer releases beyond the ones listed in `hits`. */
  more: number;
}

interface Report {
  generatedAt: string;
  sinceDays: number;
  since: string;
  news: NewsCandidate[];
  github: RepoCandidate[];
  priorArt: CommitCandidate[];
  stale: StaleEntry[];
  problems: string[];
  stats: {
    feedsChecked: number;
    feedItemsSeen: number;
    searchQueries: number;
    reposSeen: number;
    reposKnown: number;
    reposIgnored: number;
    entriesSwept: number;
  };
  /** Rows dropped by --limit, per section (all zero without --limit). */
  omitted: { news: number; github: number; priorArt: number; stale: number };
}

// ---- config ----------------------------------------------------------------

const configSchema = z.object({
  since_days: z.number().int().positive().default(14),
  user_agent: z.string().min(1),
  keywords: z.array(z.string().min(1)).default([]),
  feeds: z
    .array(z.object({ label: z.string().min(1), url: z.url(), prefiltered: z.boolean().default(false) }))
    .default([]),
  github_queries: z.array(z.string().min(1)).default([]),
  /** {name} and {manufacturer} are replaced per device. */
  device_query_template: z.string().min(1).default('{manufacturer} "{name}" firmware'),
  /** Per device category, templates that replace device_query_template (one search each). */
  category_query_templates: z.record(z.string(), z.array(z.string().min(1))).default({}),
  /** Per device slug, the names to search for instead of the device's display name. */
  device_search_names: z.record(z.string(), z.array(z.string().min(1))).default({}),
  /** Per device slug, exact search queries that replace all templates for that device. */
  device_queries: z.record(z.string(), z.array(z.string().min(1))).default({}),
  prior_art_repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'expected owner/repo')).default([]),
  ignore: z
    .array(
      z.object({
        url: z.string().min(1),
        reason: z.string().optional(),
        date: z.union([z.string(), z.date()]).optional(),
        /** URLs under this entry that stay visible, e.g. useful repos of an ignored GitHub owner. */
        except: z.array(z.string().min(1)).default([]),
      }),
    )
    .default([]),
});
type Config = z.infer<typeof configSchema>;

function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`Cannot read config ${path}: ${(e as Error).message}`);
    process.exit(1);
  }
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    console.error(`Invalid config ${path}:`);
    for (const i of parsed.error.issues) {
      console.error(`  - ${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

// ---- small helpers ------------------------------------------------------------

type Obj = Record<string, unknown>;

const asObj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
const arr = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Text of a parsed XML node: plain string/number, or the `#text` of a node with attributes. */
function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return str(v[0]);
  const o = asObj(v);
  return o ? str(o['#text']) : '';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Case-insensitive match of `s` not embedded in a longer word. */
const wordRe = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(s)}(?![\\p{L}\\p{N}])`, 'iu');

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const isoDay = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10);

function progress(msg: string) {
  console.error(msg);
}

// ---- repo keys -------------------------------------------------------------------

const GIT_HOSTS = new Set(['github.com', 'codeberg.org', 'gitlab.com']);
/** First path segments on github.com that are not owners. */
const NOT_OWNERS = new Set(['orgs', 'sponsors', 'topics', 'users', 'settings', 'marketplace', 'features', 'about']);

function hostOf(url: string): string | undefined {
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
function repoKey(url: string): string | undefined {
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

const URL_RE = /https?:\/\/[^\s"'<>()[\]{}\\^`|]+/g;
const trimUrl = (u: string) => u.replace(/[.,;:!?]+$/, '');

function urlsIn(text: string): string[] {
  return (text.match(URL_RE) ?? []).map(trimUrl);
}

// ---- catalog index ----------------------------------------------------------------

interface DeviceInfo {
  slug: string;
  name: string;
  manufacturer: string;
  category: string;
  fullName: string;
}

interface Catalog {
  knownRepos: Set<string>;
  knownHosts: Set<string>;
  devices: DeviceInfo[];
  firmwareNames: { name: string; deviceSlug: string; fwSlug: string }[];
}

function listYaml(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.yaml') || n.endsWith('.yml'))
    .map((n) => join(dir, n))
    .sort();
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

function walkStrings(v: unknown, fn: (s: string) => void) {
  if (typeof v === 'string') fn(v);
  else if (Array.isArray(v)) for (const x of v) walkStrings(x, fn);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) walkStrings(x, fn);
}

function buildCatalog(problems: string[]): Catalog {
  const knownRepos = new Set<string>();
  const knownHosts = new Set<string>();
  const devices: DeviceInfo[] = [];
  const firmwareNames: Catalog['firmwareNames'] = [];

  const addUrl = (u: string) => {
    const key = repoKey(u);
    if (key) knownRepos.add(key);
  };
  /** Reads a YAML file, registers every URL in it, and returns the parsed data. */
  const read = (file: string): Obj | undefined => {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      problems.push(`catalog: cannot read ${relative(ROOT, file)}: ${(e as Error).message}`);
      return undefined;
    }
    for (const u of urlsIn(raw)) addUrl(u);
    let data: unknown;
    try {
      data = parse(raw);
    } catch (e) {
      problems.push(`catalog: YAML error in ${relative(ROOT, file)}: ${(e as Error).message.split('\n')[0]}`);
      return undefined;
    }
    walkStrings(data, (s) => {
      for (const u of urlsIn(s)) addUrl(u);
    });
    return asObj(data);
  };
  const slugOf = (file: string) => basename(file).replace(/\.ya?ml$/, '');

  for (const file of listYaml(CATALOG_DIRS[0])) {
    const d = read(file);
    const name = d && str(d.name);
    const manufacturer = d && str(d.manufacturer);
    if (name && manufacturer) {
      const category = (d && str(d.category)) ?? '';
      devices.push({ slug: slugOf(file), name, manufacturer, category, fullName: `${manufacturer} ${name}` });
    }
  }

  for (const dir of listDirs(CATALOG_DIRS[1])) {
    for (const file of listYaml(dir)) {
      const fw = read(file);
      if (!fw) continue;
      const name = str(fw.name);
      if (name) firmwareNames.push({ name, deviceSlug: basename(dir), fwSlug: slugOf(file) });
      // Only source/homepage count as "hosts the catalog already covers"; forum or
      // video links in community sections must not.
      for (const field of ['source', 'homepage']) {
        const host = hostOf(str(fw[field]));
        if (host && host !== 'github.com') knownHosts.add(host);
      }
    }
  }

  for (const file of listYaml(CATALOG_DIRS[2])) read(file);

  return { knownRepos, knownHosts, devices, firmwareNames };
}

// ---- matching ---------------------------------------------------------------------

interface Matcher {
  slug: string;
  re: RegExp;
}

/** fullName always; bare name only when it is long enough not to hit common words (Arc, Crow, Force). */
function buildDeviceMatchers(devices: DeviceInfo[]): Matcher[] {
  const out: Matcher[] = [];
  for (const d of devices) {
    out.push({ slug: d.slug, re: wordRe(d.fullName) });
    if (d.name.length >= 5 && d.name.toLowerCase() !== d.fullName.toLowerCase()) {
      out.push({ slug: d.slug, re: wordRe(d.name) });
    }
  }
  return out;
}

function matchDevices(text: string, matchers: Matcher[]): DeviceGuess[] {
  const out: DeviceGuess[] = [];
  for (const m of matchers) {
    if (out.some((o) => o.slug === m.slug)) continue;
    const hit = m.re.exec(text);
    if (hit) out.push({ slug: m.slug, matched: hit[0] });
  }
  return out;
}

function matchKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((k) => lower.includes(k.toLowerCase()));
}

// ---- ignore list ---------------------------------------------------------------------

const normUrl = (u: string) => u.trim().toLowerCase().replace(/\/+$/, '');

function makeIgnore(entries: Config['ignore']): (url: string) => boolean {
  const prep = (u: string) => ({ norm: normUrl(u), key: repoKey(u) });
  const prepared = entries.map((e) => ({ ...prep(e.url), except: e.except.map(prep) }));
  // A GitHub repo ignore matches its repo; any other URL (including a bare github.com/<owner>)
  // matches itself and everything below it (path boundary, so ignoring .../foo does not hide
  // .../foobar).
  const matches = (p: { norm: string; key?: string }, norm: string, key?: string) =>
    (p.key !== undefined && p.key === key) ||
    norm === p.norm ||
    norm.startsWith(p.norm.endsWith('/') ? p.norm : `${p.norm}/`) ||
    norm.startsWith(`${p.norm}?`);
  return (url) => {
    const norm = normUrl(url);
    const key = repoKey(url);
    return prepared.some((p) => matches(p, norm, key) && !p.except.some((x) => matches(x, norm, key)));
  };
}

// ---- feeds ---------------------------------------------------------------------------

interface FeedItem {
  title: string;
  link: string;
  date?: Date;
  summary: string;
  /** URLs found in the item's raw markup, used to spot repos/hosts the catalog knows. */
  urls: string[];
  id: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function plainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(v: unknown): Date | undefined {
  const s = str(v);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** href of an Atom <link> (or RSS-embedded link) list: first rel=alternate, else the first with an href. */
function linkOf(v: unknown): string {
  const links = arr(v).map((l) => (typeof l === 'string' ? { href: l.trim(), rel: '' } : { href: str(asObj(l)?.['@_href']), rel: str(asObj(l)?.['@_rel']) }));
  const pick = links.find((l) => l.href && (l.rel === '' || l.rel === 'alternate')) ?? links.find((l) => l.href);
  return pick?.href ?? '';
}

function parseFeed(xml: string): FeedItem[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });
  const doc = asObj(parser.parse(xml));
  if (!doc) throw new Error('not XML');
  const rssChannel = asObj(arr(asObj(doc.rss)?.channel)[0]);
  const atomFeed = asObj(doc.feed);
  const rdf = asObj(doc['rdf:RDF']);
  const out: FeedItem[] = [];

  const push = (title: string, link: string, date: Date | undefined, rawSummary: string, id: string) => {
    if (!title && !link) return;
    out.push({
      title: plainText(title),
      link,
      date,
      summary: truncate(plainText(rawSummary), SUMMARY_MAX),
      urls: urlsIn(rawSummary).concat(link ? [link] : []),
      id: id || link,
    });
  };

  if (rssChannel || rdf) {
    for (const it of arr(rssChannel?.item ?? rdf?.item)) {
      const o = asObj(it);
      if (!o) continue;
      push(
        str(o.title),
        linkOf(o.link),
        parseDate(o.pubDate) ?? parseDate(o['dc:date']),
        str(o.description) || str(o['content:encoded']),
        str(o.guid),
      );
    }
  } else if (atomFeed) {
    for (const en of arr(atomFeed.entry)) {
      const o = asObj(en);
      if (!o) continue;
      push(
        str(o.title),
        linkOf(o.link),
        parseDate(o.published) ?? parseDate(o.updated),
        str(o.summary) || str(o.content),
        str(o.id),
      );
    }
  } else {
    throw new Error('not an RSS or Atom feed');
  }
  return out;
}

async function fetchText(url: string, userAgent: string): Promise<string> {
  let lastErr: unknown;
  let waitMs = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(waitMs || 500 * 2 ** attempt);
    waitMs = 0;
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
        },
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      });
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status}`);
        // Reddit allows about one unauthenticated request a minute and says when the
        // window reopens; wait for it (up to a minute) instead of failing the feed.
        const reset = Number(res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset'));
        if (res.status === 429 && reset > 0 && reset <= MAX_RATE_WAIT_S) waitMs = (reset + 1) * 1000;
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw Object.assign(new Error(`HTTP ${res.status}`), { final: true });
      }
      return await res.text();
    } catch (e) {
      if ((e as { final?: boolean }).final) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface FeedResult {
  ok: boolean;
  seen: number;
  news: NewsCandidate[];
}

async function gatherNews(
  config: Config,
  since: Date,
  catalog: Catalog,
  deviceMatchers: Matcher[],
  problems: string[],
): Promise<FeedResult[]> {
  const firmwareRes = new Map<string, RegExp>();
  for (const f of catalog.firmwareNames) {
    if (f.name.length >= 4 && !firmwareRes.has(f.name.toLowerCase())) firmwareRes.set(f.name.toLowerCase(), wordRe(f.name));
  }

  const one = async (feed: Config['feeds'][number]): Promise<FeedResult> => {
    let items: FeedItem[];
    try {
      items = parseFeed(await fetchText(feed.url, config.user_agent));
    } catch (e) {
      problems.push(`feed ${feed.label} (${feed.url}): ${(e as Error).message}`);
      return { ok: false, seen: 0, news: [] };
    }
    const feedHost = hostOf(feed.url);
    const news: NewsCandidate[] = [];
    for (const it of items) {
      if (it.date && it.date < since) continue;
      const text = `${it.title} ${it.summary}`;
      const matched = feed.prefiltered
        ? []
        : [...new Set([...matchKeywords(text, config.keywords), ...matchDevices(text, deviceMatchers).map((d) => d.matched)])];
      if (!feed.prefiltered && matched.length === 0) continue;

      const mentions = new Set<string>();
      for (const [lower, re] of firmwareRes) {
        if (re.test(text)) mentions.add(catalog.firmwareNames.find((f) => f.name.toLowerCase() === lower)?.name ?? lower);
      }
      for (const u of it.urls) {
        const key = repoKey(u);
        if (key && catalog.knownRepos.has(key)) mentions.add(`repo:${key}`);
        // The feed's own site is not a mention, even when the catalog links to it.
        const host = hostOf(u);
        if (host && host !== feedHost && host !== hostOf(it.link) && catalog.knownHosts.has(host)) mentions.add(`host:${host}`);
      }
      news.push({
        source: feed.label,
        title: it.title || it.link,
        link: it.link,
        date: it.date?.toISOString(),
        summary: it.summary,
        matched,
        knownMentions: [...mentions],
      });
    }
    return { ok: true, seen: items.length, news };
  };

  // Feeds on the same host (the reddit searches) run one after another, spaced out,
  // or the host answers 429. Different hosts run FEED_CONCURRENCY at a time.
  const groups = new Map<string, Config['feeds']>();
  for (const feed of config.feeds) {
    const host = hostOf(feed.url) ?? feed.url;
    groups.set(host, [...(groups.get(host) ?? []), feed]);
  }
  const grouped = await pool([...groups.values()], FEED_CONCURRENCY, async (feeds) => {
    const results: FeedResult[] = [];
    for (const [i, feed] of feeds.entries()) {
      if (i > 0) await sleep(SAME_HOST_DELAY_MS);
      results.push(await one(feed));
    }
    return results;
  });
  return grouped.flat();
}

// ---- GitHub (via gh) ---------------------------------------------------------------------

type GhResult = { ok: true; json: unknown } | { ok: false; status?: number; message: string };

const GH_OPTIONS = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000 } as const;

function ghError(e: unknown): GhResult {
  const err = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
  if (err.code === 'ENOENT') return { ok: false, message: 'gh CLI not found; install it and run `gh auth login`' };
  const detail = `${err.stderr ?? ''}\n${err.stdout ?? ''}`;
  const status = /HTTP (\d{3})/.exec(detail)?.[1];
  const message = (err.stderr || err.message).split('\n').find((l) => l.trim()) ?? 'gh api failed';
  return { ok: false, status: status ? Number(status) : undefined, message: message.trim() };
}

function gh(args: string[]): GhResult {
  try {
    const out = execFileSync('gh', ['api', ...args], { ...GH_OPTIONS, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, json: JSON.parse(out) as unknown };
  } catch (e) {
    return ghError(e);
  }
}

const execFileAsync = promisify(execFile);

interface SearchOutcome {
  repos: Map<string, RepoCandidate>;
  queriesRun: number;
  queriesOk: number;
}

/** Results read per search; GitHub's GraphQL search returns at most 100 at a time. */
const SEARCH_PAGE = 100;

const SEARCH_FIELDS =
  'repositoryCount nodes { ... on Repository { nameWithOwner url description stargazerCount pushedAt licenseInfo { spdxId } repositoryTopics(first: 20) { nodes { topic { name } } } } }';

interface GqlItem {
  alias: string;
  /** Becomes GraphQL variables named `<alias>_<key>`; `field` receives a function that names them. */
  vars: Record<string, string>;
  field: (v: (key: string) => string) => string;
}

type GqlResult =
  | { ok: true; data: Obj; errors: Map<string, string> }
  | { ok: false; limited: boolean; message: string };

/** One `gh api graphql` request carrying every item as an aliased root field. */
async function graphqlOnce(items: GqlItem[]): Promise<GqlResult> {
  const decl: string[] = [];
  const args: string[] = [];
  const body = items.map((it) => {
    for (const [k, val] of Object.entries(it.vars)) {
      decl.push(`$${it.alias}_${k}: String!`);
      args.push('-f', `${it.alias}_${k}=${val}`);
    }
    return `${it.alias}: ${it.field((k) => `$${it.alias}_${k}`)}`;
  });
  args.unshift('graphql', '-f', `query=query(${decl.join(', ')}) {\n${body.join('\n')}\n}`);
  let out: string;
  let err = '';
  try {
    ({ stdout: out } = await execFileAsync('gh', ['api', ...args], GH_OPTIONS));
  } catch (e) {
    // gh exits non-zero for GraphQL errors too, with the response body on stdout.
    out = (e as { stdout?: string }).stdout ?? '';
    err = (e as { stderr?: string }).stderr ?? '';
    if (!out.trim().startsWith('{')) {
      const r = ghError(e);
      return { ok: false, limited: r.ok === false && (r.status === 403 || r.status === 429), message: r.ok === false ? r.message : 'gh api failed' };
    }
  }
  const json = asObj(JSON.parse(out));
  const data = asObj(json?.data);
  const errors = arr(json?.errors).map((x) => asObj(x));
  const limited = errors.some((x) => /RATE_LIMITED|rate limit/i.test(`${str(x?.type)} ${str(x?.message)}`)) || /rate limit|HTTP 40[39]/i.test(err);
  if (!data) {
    return { ok: false, limited, message: str(errors[0]?.message) || err.split('\n').find((l) => l.trim()) || 'GraphQL request failed' };
  }
  // An error whose path starts at an alias (a repository that does not exist) belongs to that alias.
  const byAlias = new Map<string, string>();
  for (const x of errors) {
    const alias = str(arr(x?.path)[0]);
    if (alias && !byAlias.has(alias)) byAlias.set(alias, str(x?.message) || 'error');
  }
  return { ok: true, data, errors: byAlias };
}

/** graphqlOnce, waiting out GitHub's rate limit (about a minute) between retries. */
async function graphql(items: GqlItem[]): Promise<GqlResult> {
  for (let attempt = 0; ; attempt++) {
    const res = await graphqlOnce(items);
    if (res.ok || !res.limited || attempt >= SEARCH_RATE_RETRIES) return res;
    progress(`  GitHub rate limit; waiting ${SEARCH_RATE_WAIT_MS / 1000} s, then retrying (${attempt + 1}/${SEARCH_RATE_RETRIES})`);
    await sleep(SEARCH_RATE_WAIT_MS);
  }
}

type SearchBatch = { ok: true; results: Map<string, unknown> } | { ok: false; limited: boolean; message: string };

/**
 * Runs several repository searches in one GraphQL request (one aliased `search` each).
 * The REST search endpoint is capped at 30 requests a minute and trips a secondary
 * limit even below that; GraphQL search is billed against the 5000 points/hour GraphQL
 * budget, so one request carries a whole batch.
 */
async function searchBatch(qs: string[]): Promise<SearchBatch> {
  const res = await graphql(
    qs.map((_, i) => ({
      alias: `s${i}`,
      vars: { q: qs[i] },
      field: (v) => `search(query: ${v('q')}, type: REPOSITORY, first: ${SEARCH_PAGE}) { ${SEARCH_FIELDS} }`,
    })),
  );
  if (res.ok === false) {
    if (res.limited || qs.length === 1) return res;
    // A batch of large searches can come back as a 502 from GitHub, so ask for it in two halves.
    const mid = Math.ceil(qs.length / 2);
    const left = await searchBatch(qs.slice(0, mid));
    if (left.ok === false) return left;
    const right = await searchBatch(qs.slice(mid));
    if (right.ok === false) return right;
    return { ok: true, results: new Map([...left.results, ...right.results]) };
  }
  const results = new Map<string, unknown>();
  qs.forEach((q, i) => {
    const r = res.data[`s${i}`];
    if (r) results.set(q, r);
  });
  return { ok: true, results };
}

/** GraphQL search silently returns fewer nodes than repositoryCount when it times out inside GitHub. */
function searchIncomplete(r: unknown): boolean {
  const o = asObj(r);
  const count = typeof o?.repositoryCount === 'number' ? o.repositoryCount : 0;
  return arr(o?.nodes).filter((n) => asObj(n)?.nameWithOwner).length < Math.min(count, SEARCH_PAGE);
}

async function runSearches(queries: string[], since: Date, problems: string[]): Promise<SearchOutcome> {
  const repos = new Map<string, RepoCandidate>();
  const day = isoDay(since);
  const full = (base: string) => `${base} fork:false pushed:>${day} sort:updated`;
  let run = 0;
  let ok = 0;
  let first = true;
  for (let i = 0; i < queries.length; i += SEARCH_BATCH) {
    const bases = queries.slice(i, i + SEARCH_BATCH);
    progress(`  searches ${i + 1}-${i + bases.length}/${queries.length}`);
    // `pending` shrinks as queries come back complete; incomplete ones are asked again.
    let pending = bases;
    const done = new Map<string, unknown>();
    for (let attempt = 0; pending.length && attempt <= SEARCH_INCOMPLETE_RETRIES; attempt++) {
      if (!first) await sleep(SEARCH_DELAY_MS);
      first = false;
      const res = await searchBatch(pending.map(full));
      if (res.ok === false) {
        if (res.limited) {
          problems.push(`GitHub search rate limit hit after ${run} of ${queries.length} queries and ${SEARCH_RATE_RETRIES} retries (${res.message}); results are partial`);
          return { repos, queriesRun: run, queriesOk: ok };
        }
        problems.push(`GitHub search batch starting "${pending[0]}": ${res.message}`);
        break;
      }
      const next: string[] = [];
      for (const base of pending) {
        const r = res.results.get(full(base));
        if (r === undefined) problems.push(`GitHub search "${base}": no result returned`);
        else if (searchIncomplete(r) && attempt < SEARCH_INCOMPLETE_RETRIES) next.push(base);
        else done.set(base, r);
      }
      pending = next;
    }
    for (const base of bases) {
      run++;
      const r = done.get(base);
      if (r === undefined) continue;
      ok++;
      const matched = asObj(r)?.repositoryCount;
      if (typeof matched === 'number' && matched > SEARCH_PAGE) {
        problems.push(`GitHub search "${base}" matched ${matched} repos; only the ${SEARCH_PAGE} most recently updated were read, so narrow it or shorten --since-days`);
      }
      for (const item of arr(asObj(r)?.nodes)) {
        const o = asObj(item);
        const fullName = o && str(o.nameWithOwner);
        if (!o || !fullName) continue;
        const key = fullName.toLowerCase();
        const existing = repos.get(key);
        if (existing) {
          if (!existing.queries.includes(base)) existing.queries.push(base);
          continue;
        }
        repos.set(key, {
          repo: fullName,
          url: str(o.url) || `https://github.com/${fullName}`,
          description: str(o.description),
          stars: typeof o.stargazerCount === 'number' ? o.stargazerCount : 0,
          pushed: str(o.pushedAt),
          license: str(asObj(o.licenseInfo)?.spdxId) || undefined,
          topics: arr(asObj(o.repositoryTopics)?.nodes).map((t) => str(asObj(asObj(t)?.topic)?.name)).filter(Boolean),
          queries: [base],
          deviceGuess: [],
        });
      }
    }
  }
  return { repos, queriesRun: run, queriesOk: ok };
}

function gatherPriorArt(repos: string[], since: Date, problems: string[]): { commits: CommitCandidate[]; ok: number } {
  const commits: CommitCandidate[] = [];
  let ok = 0;
  for (const repo of repos) {
    progress(`  commits: ${repo}`);
    const res = gh([`repos/${repo}/commits?since=${since.toISOString()}&per_page=30`]);
    if (res.ok === false) {
      problems.push(`prior art ${repo}: ${res.message}`);
      continue;
    }
    ok++;
    for (const c of arr(res.json)) {
      const o = asObj(c);
      const commit = asObj(o?.commit);
      const sha = str(o?.sha);
      if (!o || !commit || !sha) continue;
      const date = str(asObj(commit.committer)?.date) || str(asObj(commit.author)?.date);
      commits.push({
        repo,
        sha7: sha.slice(0, 7),
        date,
        subject: str(commit.message).split('\n')[0].trim(),
        url: str(o.html_url) || `https://github.com/${repo}/commit/${sha}`,
      });
    }
  }
  return { commits, ok };
}

// ---- release sweep ----------------------------------------------------------------------------

interface SweepTarget {
  file: string;
  name: string;
  device: string;
  repo: string;
  /** Branch and subfolder of a `/tree/<branch>/<path>` source URL. */
  branch?: string;
  path?: string;
  versions: { version: string; date?: string; url?: string }[];
  /** Lowercased file text, to tell whether a tag is named outside versions[]. */
  text: string;
}

/** `main @ 1a2b3c4` style versions, which track the latest commit of a branch. */
const COMMIT_VERSION = /^(\S+) @ ([0-9a-f]{7,40})$/i;
const GITHUB_SOURCE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/\s]+)(?:\/(\S+?))?)?\/?$/;

/** `smk-pad-lights-953` → "smk", `kit v0.5.0` → "kit"; plain versions such as `v1.2` have none. */
function versionPrefix(v: string): string | undefined {
  if (/^v?\d/i.test(v)) return undefined;
  return /^([a-z][a-z0-9]*)[-_ ]/i.exec(v)?.[1].toLowerCase();
}

/** True when the tag, with or without its leading v, already appears in the file as a whole version. */
function mentions(text: string, tag: string): boolean {
  const forms = new Set([tag.toLowerCase(), tag.toLowerCase().replace(/^v(?=\d)/, '')]);
  return [...forms].some((f) => new RegExp(`(?<![\\w.-])${escapeRe(f)}(?![\\w-]|\\.\\d)`).test(text));
}

/** True when a row of versions[] is this tag: by its version string, or by a URL that ends in the tag. */
function listed(versions: SweepTarget['versions'], tag: string): boolean {
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

/** Every firmware entry whose `source` is a GitHub repo, except archived ones and SWEEP_SKIP_REPOS. */
function buildSweepTargets(): SweepTarget[] {
  const targets: SweepTarget[] = [];
  for (const dir of listDirs(CATALOG_DIRS[1])) {
    for (const file of listYaml(dir)) {
      let raw: string;
      let fw: Obj | undefined;
      try {
        raw = readFileSync(file, 'utf8');
        fw = asObj(parse(raw));
      } catch {
        continue; // buildCatalog already reported it
      }
      if (!fw || str(fw.status) === 'archived') continue;
      const m = GITHUB_SOURCE.exec(str(fw.source));
      if (!m) continue;
      const repo = `${m[1]}/${m[2]}`;
      if (SWEEP_SKIP_REPOS.has(repo.toLowerCase())) continue;
      const versions = arr(fw.versions)
        .map(asObj)
        .filter((v): v is Obj => !!v)
        .map((v) => ({ version: str(v.version), date: str(v.date) || undefined, url: str(v.url) || undefined }))
        .filter((v) => v.version);
      targets.push({
        file: relative(ROOT, file),
        name: str(fw.name) || basename(file),
        device: basename(dir),
        repo,
        branch: m[3],
        path: m[4],
        versions,
        text: raw.toLowerCase(),
      });
    }
  }
  return targets;
}

interface RepoSweep {
  defaultBranch?: string;
  releases: { tag: string; date: string; url: string; prerelease: boolean }[];
  /** Newest first. */
  tags: string[];
}

interface BranchHead {
  sha: string;
  date?: string;
  url: string;
}

/** What the batched lookups found: the repo's releases and tags, and branch heads by headKey(). */
interface SweepData {
  repos: Map<string, RepoSweep>;
  /** A key present with `undefined` means the ref exists but has no commit at the path. */
  heads: Map<string, BranchHead | undefined | null>;
}

const headKey = (repo: string, branch: string, path?: string) => `${repo.toLowerCase()}\n${branch}\n${path ?? ''}`;

/**
 * Releases newer than the last one in the entry's versions[]; for `<branch> @ <sha>`
 * entries also a moved branch head; for repos without releases, tags newer than the
 * last one listed. Prose never hides a release, it only flags it. An entry with no
 * dated version has nothing to compare against, so there prose still counts as listed.
 */
function sweepEntry(t: SweepTarget, data: SweepData, report: (msg: string) => void): StaleEntry | undefined {
  const top = t.versions[0];
  const commitTop = top ? COMMIT_VERSION.exec(top.version) : null;
  const known = new Set(t.versions.map((v) => versionPrefix(v.version)).filter(Boolean));
  const ownName = `${t.repo.split('/')[1]} ${t.name}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  const otherComponent = (tag: string) => {
    const prefix = versionPrefix(tag);
    return prefix && !known.has(prefix) && !ownName.includes(prefix) ? prefix : undefined;
  };
  const hits: ReleaseHit[] = [];
  const lastDate = t.versions.reduce<string | undefined>((max, v) => (v.date && (!max || v.date > max) ? v.date : max), undefined);

  const info = data.repos.get(t.repo.toLowerCase());
  if (!info) return undefined; // runReleaseSweep reported why
  for (const r of info.releases) {
    if (!r.tag) continue;
    // Newest first, so everything after a listed release is older than the catalog's.
    if (listed(t.versions, r.tag)) break;
    if (lastDate ? r.date < lastDate : mentions(t.text, r.tag)) continue;
    hits.push({
      kind: 'release',
      ref: r.tag,
      date: r.date,
      url: r.url || `https://github.com/${t.repo}/releases/tag/${encodeURIComponent(r.tag)}`,
      prerelease: r.prerelease || undefined,
      otherComponent: otherComponent(r.tag),
      mentioned: mentions(t.text, r.tag) || undefined,
    });
  }

  if (commitTop) {
    const [, named, sha] = commitTop;
    let branch = named;
    const head = (b: string) => data.heads.get(headKey(t.repo, b, t.branch === b ? t.path : undefined));
    let res = head(branch);
    if (res === null) {
      // CONTRIBUTING wants the label to name the default branch; say so and compare against that one.
      const fallback = info.defaultBranch ?? '';
      if (fallback && fallback !== named) {
        report(`release sweep ${t.file}: version "${top.version}" names branch "${named}", which ${t.repo} does not have; its default branch is "${fallback}"`);
        branch = fallback;
        res = head(branch);
      }
    }
    if (res === null) {
      report(`release sweep ${t.repo} (${t.file}): branch ${branch}: not found`);
    } else if (res) {
      // A source pointing at a subfolder can name a repo-wide commit newer than the folder's last change.
      const newer = !top.date || !res.date || res.date >= top.date;
      if (res.sha && newer && !res.sha.toLowerCase().startsWith(sha.toLowerCase())) {
        hits.unshift({
          kind: 'commit',
          ref: `${branch} @ ${res.sha.slice(0, 7)}`,
          date: res.date,
          url: res.url || `https://github.com/${t.repo}/commit/${res.sha}`,
        });
      }
    }
  } else if (info.releases.length === 0) {
    for (const name of info.tags) {
      if (listed(t.versions, name)) break;
      hits.push({
        kind: 'tag',
        ref: name,
        url: `https://github.com/${t.repo}/tree/${encodeURIComponent(name)}`,
        otherComponent: otherComponent(name),
        mentioned: mentions(t.text, name) || undefined,
      });
    }
  }

  if (!hits.length) return undefined;
  return {
    file: t.file,
    name: t.name,
    device: t.device,
    repo: t.repo,
    top: top && { version: top.version, date: top.date },
    hits: hits.slice(0, SWEEP_HITS_MAX),
    more: Math.max(0, hits.length - SWEEP_HITS_MAX),
  };
}

const REPO_SWEEP_FIELDS =
  'defaultBranchRef { name } ' +
  'releases(first: 20, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { tagName isDraft isPrerelease publishedAt createdAt url } } ' +
  'refs(refPrefix: "refs/tags/", first: 10, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) { nodes { name } }';

function parseRepoSweep(o: Obj): RepoSweep {
  return {
    defaultBranch: str(asObj(o.defaultBranchRef)?.name) || undefined,
    releases: arr(asObj(o.releases)?.nodes)
      .map(asObj)
      .filter((r): r is Obj => !!r && r.isDraft !== true)
      .map((r) => ({
        tag: str(r.tagName),
        date: isoDay(str(r.publishedAt) || str(r.createdAt)),
        url: str(r.url),
        prerelease: r.isPrerelease === true,
      })),
    tags: arr(asObj(o.refs)?.nodes)
      .map((n) => str(asObj(n)?.name))
      .filter(Boolean),
  };
}

async function runReleaseSweep(
  targets: SweepTarget[],
  problems: string[],
): Promise<{ stale: StaleEntry[]; calls: number; ok: number }> {
  // Monorepos back several entries; ask GitHub once per repo and once per branch/path.
  const repoNames = new Map<string, string>();
  const repoFiles = new Map<string, string>();
  for (const t of targets) {
    repoNames.set(t.repo.toLowerCase(), t.repo);
    if (!repoFiles.has(t.repo.toLowerCase())) repoFiles.set(t.repo.toLowerCase(), t.file);
  }
  const data: SweepData = { repos: new Map(), heads: new Map() };
  let calls = 0;
  let ok = 0;
  let limited = false;
  const reported = new Set<string>();
  const report = (repo: string, msg: string) => {
    if (limited || reported.has(repo.toLowerCase())) return;
    reported.add(repo.toLowerCase());
    problems.push(msg);
  };

  const run = async (items: GqlItem[]): Promise<GqlResult | undefined> => {
    if (limited) return undefined;
    calls++;
    const res = await graphql(items);
    if (res.ok) ok++;
    else if (res.limited) limited = true;
    else problems.push(`release sweep: ${res.message}`);
    return res;
  };
  const batches = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / SWEEP_BATCH) }, (_, i) => xs.slice(i * SWEEP_BATCH, (i + 1) * SWEEP_BATCH));
  const split = (repo: string) => {
    const [owner, name] = repo.split('/');
    return { owner, name };
  };

  // 1. Releases, tags and the default branch of every repo.
  const repoKeys = [...repoNames.keys()];
  let done = 0;
  await pool(batches(repoKeys), SWEEP_CONCURRENCY, async (batch) => {
    const res = await run(
      batch.map((key, i) => ({
        alias: `r${i}`,
        vars: split(repoNames.get(key)!),
        field: (v) => `repository(owner: ${v('owner')}, name: ${v('name')}) { ${REPO_SWEEP_FIELDS} }`,
      })),
    );
    if (res?.ok) {
      batch.forEach((key, i) => {
        const o = asObj(res.data[`r${i}`]);
        if (o) data.repos.set(key, parseRepoSweep(o));
        else report(repoNames.get(key)!, `release sweep ${repoNames.get(key)} (${repoFiles.get(key)}): ${res.errors.get(`r${i}`) ?? 'not found'}`);
      });
    }
    done += batch.length;
    progress(`  swept ${Math.min(done, repoKeys.length)}/${repoKeys.length} repos`);
  });

  // 2. Branch heads for `<branch> @ <sha>` entries; a branch the repo lacks is retried on its default branch.
  const headWanted = new Map<string, { repo: string; branch: string; path?: string }>();
  const want = (repo: string, branch: string, path?: string) => headWanted.set(headKey(repo, branch, path), { repo, branch, path });
  for (const t of targets) {
    const m = t.versions[0] && COMMIT_VERSION.exec(t.versions[0].version);
    if (m && data.repos.has(t.repo.toLowerCase())) want(t.repo, m[1], t.branch === m[1] ? t.path : undefined);
  }
  const fetchHeads = async (wanted: { repo: string; branch: string; path?: string }[]) => {
    await pool(batches(wanted), SWEEP_CONCURRENCY, async (batch) => {
      const res = await run(
        batch.map((w, i) => ({
          alias: `h${i}`,
          vars: { ...split(w.repo), expr: w.branch, ...(w.path ? { path: w.path } : {}) },
          field: (v) =>
            `repository(owner: ${v('owner')}, name: ${v('name')}) { object(expression: ${v('expr')}) { ... on Commit { history(first: 1${w.path ? `, path: ${v('path')}` : ''}) { nodes { oid committedDate url } } } } }`,
        })),
      );
      if (!res?.ok) return;
      batch.forEach((w, i) => {
        const key = headKey(w.repo, w.branch, w.path);
        const obj = asObj(asObj(asObj(res.data[`h${i}`])?.object));
        const node = asObj(arr(asObj(obj?.history)?.nodes)[0]);
        if (!obj?.history) data.heads.set(key, null);
        else data.heads.set(key, node && { sha: str(node.oid), date: isoDay(str(node.committedDate)) || undefined, url: str(node.url) });
      });
    });
  };
  await fetchHeads([...headWanted.values()]);
  const fallbacks = new Map<string, { repo: string; branch: string; path?: string }>();
  for (const t of targets) {
    const m = t.versions[0] && COMMIT_VERSION.exec(t.versions[0].version);
    const info = data.repos.get(t.repo.toLowerCase());
    if (!m || !info?.defaultBranch || data.heads.get(headKey(t.repo, m[1], t.branch === m[1] ? t.path : undefined)) !== null) continue;
    const b = info.defaultBranch;
    if (b !== m[1]) fallbacks.set(headKey(t.repo, b, t.branch === b ? t.path : undefined), { repo: t.repo, branch: b, path: t.branch === b ? t.path : undefined });
  }
  await fetchHeads([...fallbacks.values()]);

  const results = targets.map((t) => sweepEntry(t, data, (msg) => report(`${t.repo}\n${msg}`, msg)));
  if (limited) problems.push('release sweep: GitHub rate limit hit; results are partial');
  return { stale: results.filter((r): r is StaleEntry => !!r), calls, ok };
}

// ---- output -----------------------------------------------------------------------------------

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const linkText = (s: string) => cell(s).replace(/[[\]]/g, '\\$&');

function renderMarkdown(r: Report, outPath: string): string {
  const L: string[] = [];
  L.push(
    `Discover candidates, last ${r.sinceDays} days (since ${isoDay(r.since)}): ${r.news.length + r.omitted.news} news item(s) from ${r.stats.feedsChecked} feed(s) ` +
      `(${r.stats.feedItemsSeen} items seen), ${r.github.length + r.omitted.github} GitHub repo(s) not in the catalog ` +
      `(${r.stats.reposSeen} seen, ${r.stats.reposKnown} already known, ${r.stats.reposIgnored} ignored, ${r.stats.searchQueries} searches), ` +
      `${r.priorArt.length + r.omitted.priorArt} prior-art commit(s), ` +
      `${r.stale.length + r.omitted.stale} catalogued entr${r.stale.length + r.omitted.stale === 1 ? 'y' : 'ies'} with newer releases (${r.stats.entriesSwept} checked), ` +
      `${r.problems.length} problem(s).`,
  );
  const more = (n: number) => (n > 0 ? [``, `… and ${n} more (raise --limit to see them)`] : []);

  L.push('', `## News (${r.news.length + r.omitted.news})`, '');
  if (r.news.length) {
    L.push('| Date | Source | Title | Matched | Mentions catalog |', '| --- | --- | --- | --- | --- |');
    for (const n of r.news) {
      L.push(
        `| ${n.date ? isoDay(n.date) : ''} | ${cell(n.source)} | [${linkText(truncate(n.title, 100))}](${n.link}) | ${cell(n.matched.join(', ') || '(search feed)')} | ${cell(n.knownMentions.join(', '))} |`,
      );
    }
    L.push(...more(r.omitted.news));
  } else L.push('None.');

  L.push('', `## GitHub repos not in the catalog (${r.github.length + r.omitted.github})`, '');
  if (r.github.length) {
    L.push('| Pushed | Repo | Stars | License | Description | Device guess | Queries |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const g of r.github) {
      const queries = g.queries.slice(0, 3).join(' · ') + (g.queries.length > 3 ? ` (+${g.queries.length - 3})` : '');
      L.push(
        `| ${isoDay(g.pushed)} | [${linkText(g.repo)}](${g.url}) | ${g.stars} | ${cell(g.license ?? '')} | ${cell(truncate(g.description, DESCRIPTION_MAX))} | ${cell(g.deviceGuess.map((d) => d.slug).join(', '))} | ${cell(queries)} |`,
      );
    }
    L.push(...more(r.omitted.github));
  } else L.push('None.');

  L.push('', `## Prior-art list changes (${r.priorArt.length + r.omitted.priorArt})`, '');
  if (r.priorArt.length) {
    L.push('| Date | Repo | Commit | Subject |', '| --- | --- | --- | --- |');
    for (const c of r.priorArt) {
      L.push(`| ${isoDay(c.date)} | ${cell(c.repo)} | [${c.sha7}](${c.url}) | ${cell(truncate(c.subject, 140))} |`);
    }
    L.push(...more(r.omitted.priorArt));
  } else L.push('None.');

  L.push('', `## Catalogued entries with newer releases (${r.stale.length + r.omitted.stale})`, '');
  if (r.stale.length) {
    L.push('| Entry | Repo | Current top | Newer |', '| --- | --- | --- | --- |');
    for (const s of r.stale) {
      const hits = s.hits.map((h) => {
        const flags = [h.kind === 'tag' && 'tag', h.prerelease && 'pre', h.otherComponent && `other component? "${h.otherComponent}"`, h.mentioned && 'named in prose']
          .filter(Boolean)
          .join(', ');
        return `[${linkText(h.ref)}](${h.url})${h.date ? ` ${h.date}` : ''}${flags ? ` (${flags})` : ''}`;
      });
      if (s.more) hits.push(`+${s.more} more`);
      const top = s.top ? `${s.top.version}${s.top.date ? ` (${s.top.date})` : ''}` : 'no versions';
      L.push(`| ${cell(s.file)} | ${cell(s.repo)} | ${cell(top)} | ${cell(hits.join(' · '))} |`);
    }
    L.push(...more(r.omitted.stale));
  } else L.push('None.');

  if (r.problems.length) {
    L.push('', '## Problems', '');
    for (const p of r.problems) L.push(`- ${p}`);
  }
  L.push('', `Full JSON written to ${outPath}.`);
  return L.join('\n');
}

/** Path relative to the working directory when it is inside it, else absolute. */
function displayPath(p: string): string {
  const rel = relative(process.cwd(), p);
  return rel && !rel.startsWith('..') ? rel : p;
}

const HELP = `Usage: pnpm discover:candidates [options]

Gathers firmware candidates (news, GitHub repos, prior-art list commits) that
are not yet in the catalog, and catalogued entries whose GitHub repo has releases
newer than the entry's top version. Settings live in
.claude/skills/discover/config.yaml.

Options:
  --since-days N       Lookback window in days (default: config since_days)
  --limit N            Max rows per section (default: unlimited)
  --filter <text>      Keep only candidates whose title/description/url contain the text
  --no-feeds           Skip the news feeds
  --no-github          Skip all GitHub calls (searches, prior-art commits, release sweep)
  --no-device-queries  Skip the per-device GitHub searches (batched, about 3 s per 10)
  --no-release-sweep   Skip checking catalogued entries for newer releases (about half a minute)
  --out <file>         JSON output path (default: discover-candidates.json in the repo root)
  --json               Print JSON to stdout instead of a markdown report
  --config <path>      Config file (default: config.yaml next to this script)
  --help               Show this help

Exit codes: 0 success (even with problems), 1 config error or every network
source failed, 2 bad usage.`;

function positiveInt(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--${name} expects a positive integer, got "${v}"`);
    process.exit(2);
  }
  return n;
}

// ---- main ---------------------------------------------------------------------------------------

async function main() {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      options: {
        'since-days': { type: 'string' },
        limit: { type: 'string' },
        filter: { type: 'string' },
        'no-device-queries': { type: 'boolean' },
        'no-release-sweep': { type: 'boolean' },
        'no-feeds': { type: 'boolean' },
        'no-github': { type: 'boolean' },
        out: { type: 'string' },
        json: { type: 'boolean' },
        config: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (values.help) {
    console.log(HELP);
    return;
  }
  const opt = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);

  const config = loadConfig(opt('config') ? resolve(opt('config')!) : DEFAULT_CONFIG);
  const sinceDays = positiveInt('since-days', opt('since-days')) ?? config.since_days;
  const limit = positiveInt('limit', opt('limit'));
  const filter = opt('filter')?.toLowerCase();
  const outPath = opt('out') ? resolve(opt('out')!) : DEFAULT_OUT;
  const now = new Date();
  const since = new Date(now.getTime() - sinceDays * DAY_MS);
  const problems: string[] = [];

  const catalog = buildCatalog(problems);
  const deviceMatchers = buildDeviceMatchers(catalog.devices);
  const isIgnored = makeIgnore(config.ignore);
  progress(
    `Catalog: ${catalog.devices.length} devices, ${catalog.firmwareNames.length} firmwares, ${catalog.knownRepos.size} known repos, ${catalog.knownHosts.size} known hosts. Window: ${sinceDays} days.`,
  );

  // Network sources that were attempted / that answered at least once.
  let attempted = 0;
  let succeeded = 0;
  const stats: Report['stats'] = {
    feedsChecked: 0,
    feedItemsSeen: 0,
    searchQueries: 0,
    reposSeen: 0,
    reposKnown: 0,
    reposIgnored: 0,
    entriesSwept: 0,
  };

  // News.
  let news: NewsCandidate[] = [];
  if (!values['no-feeds'] && config.feeds.length) {
    progress(`Fetching ${config.feeds.length} feeds...`);
    const results = await gatherNews(config, since, catalog, deviceMatchers, problems);
    attempted += results.length;
    for (const r of results) {
      if (r.ok) {
        succeeded++;
        stats.feedsChecked++;
        stats.feedItemsSeen += r.seen;
      }
      news.push(...r.news);
    }
    const seenLinks = new Set<string>();
    news = news.filter((n) => {
      if (isIgnored(n.link)) return false;
      if (seenLinks.has(n.link)) return false;
      seenLinks.add(n.link);
      return true;
    });
    news.sort((a, b) => (b.date ? Date.parse(b.date) : -Infinity) - (a.date ? Date.parse(a.date) : -Infinity));
  }

  // GitHub.
  let github: RepoCandidate[] = [];
  let priorArt: CommitCandidate[] = [];
  let stale: StaleEntry[] = [];
  if (!values['no-github']) {
    const queries = [...config.github_queries];
    if (!values['no-device-queries']) {
      for (const d of catalog.devices) {
        const exact = config.device_queries[d.slug];
        if (exact) {
          queries.push(...exact);
          continue;
        }
        // "Mega Drive / Genesis" never matches as one quoted phrase; search the first name unless overridden.
        const names = config.device_search_names[d.slug] ?? [d.name.split(' / ')[0].trim()];
        const templates = config.category_query_templates[d.category] ?? [config.device_query_template];
        for (const name of names) {
          for (const t of templates) {
            queries.push(t.replaceAll('{name}', name).replaceAll('{manufacturer}', d.manufacturer));
          }
        }
      }
    }
    const unique = [...new Set(queries)];
    if (unique.length) {
      progress(`Running ${unique.length} GitHub searches (about ${Math.ceil((unique.length / SEARCH_BATCH) * (SEARCH_DELAY_MS / 1000 + 2))} s)...`);
      const found = await runSearches(unique, since, problems);
      attempted += found.queriesRun;
      succeeded += found.queriesOk;
      stats.searchQueries = found.queriesRun;
      stats.reposSeen = found.repos.size;
      // The prior-art lists are catalogs, not firmware; never offer them as candidates.
      const priorArtKeys = new Set(config.prior_art_repos.map((r) => r.toLowerCase()));
      for (const [key, repo] of found.repos) {
        if (catalog.knownRepos.has(key) || priorArtKeys.has(key)) {
          stats.reposKnown++;
          continue;
        }
        if (isIgnored(repo.url)) {
          stats.reposIgnored++;
          continue;
        }
        repo.deviceGuess = matchDevices(`${repo.repo} ${repo.description}`, deviceMatchers);
        github.push(repo);
      }
      github.sort((a, b) => Date.parse(b.pushed) - Date.parse(a.pushed));
    }

    if (config.prior_art_repos.length) {
      progress(`Reading commits of ${config.prior_art_repos.length} prior-art repos...`);
      const pa = gatherPriorArt(config.prior_art_repos, since, problems);
      attempted += config.prior_art_repos.length;
      succeeded += pa.ok;
      priorArt = pa.commits.filter((c) => !isIgnored(c.url));
      priorArt.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    }

    if (!values['no-release-sweep']) {
      const targets = buildSweepTargets();
      progress(`Checking ${targets.length} catalogued GitHub sources for newer releases...`);
      const sweep = await runReleaseSweep(targets, problems);
      if (sweep.calls > 0) attempted++;
      if (sweep.ok > 0) succeeded++;
      stats.entriesSwept = targets.length;
      // By file path, so one device's entries sit together for batching.
      stale = sweep.stale.sort((a, b) => a.file.localeCompare(b.file));
    }
  }

  // --filter, then --limit.
  if (filter) {
    const has = (...parts: string[]) => parts.some((p) => p.toLowerCase().includes(filter));
    news = news.filter((n) => has(n.title, n.summary, n.link));
    github = github.filter((g) => has(g.repo, g.description, g.url));
    priorArt = priorArt.filter((c) => has(c.subject, c.repo, c.url));
    stale = stale.filter((s) => has(s.name, s.repo, s.file));
  }
  const omitted = { news: 0, github: 0, priorArt: 0, stale: 0 };
  if (limit !== undefined) {
    omitted.news = Math.max(0, news.length - limit);
    omitted.github = Math.max(0, github.length - limit);
    omitted.priorArt = Math.max(0, priorArt.length - limit);
    omitted.stale = Math.max(0, stale.length - limit);
    news = news.slice(0, limit);
    github = github.slice(0, limit);
    priorArt = priorArt.slice(0, limit);
    stale = stale.slice(0, limit);
  }

  const report: Report = {
    generatedAt: now.toISOString(),
    sinceDays,
    since: since.toISOString(),
    news,
    github,
    priorArt,
    stale,
    problems,
    stats,
    omitted,
  };

  const json = JSON.stringify(report, null, 2) + '\n';
  try {
    writeFileSync(outPath, json);
  } catch (e) {
    problems.push(`could not write ${outPath}: ${(e as Error).message}`);
  }
  console.log(values.json ? json.trimEnd() : renderMarkdown(report, displayPath(outPath)));

  if (attempted > 0 && succeeded === 0) {
    console.error('Every network source failed.');
    process.exit(1);
  }
}

await main();
