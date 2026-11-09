/**
 * The project quality index: a 0–100 composite of six pillars, computed at
 * build time from the GitHub metrics snapshot (src/lib/repo-metrics.ts) and the
 * catalog itself. Methodology, weights and thresholds are published on
 * /about/quality; keep that page in step with this file.
 *
 * Every signal is log-scaled against a cap, as in the OpenSSF Criticality
 * Score: norm(S, T) = log(1+S) / log(1+max(S, T)), so 0 → 0 and anything at or
 * above T → 1. The thresholds are set near the 95th percentile of this catalog
 * (`pnpm metrics:report` prints them); recalibrate when the catalog grows a lot.
 *
 * All "now"-relative signals use the record's own fetchedAt (falling back to the
 * snapshot's), not the build date, so a score only changes when the data does.
 */
import type { Status } from '@/content/schema';
import { parseGithubSource, type MetricsSnapshot, type RepoMetrics, type PathMetrics } from './repo-metrics';
import { slugify } from './slug';

export const PILLARS = ['maturity', 'popularity', 'vitality', 'issues', 'influence', 'community'] as const;
export type Pillar = (typeof PILLARS)[number];

/** The pillars averaged into the score; Influence is a bonus on top (INFLUENCE_BONUS). */
export type WeightedPillar = Exclude<Pillar, 'influence'>;

/** Composite weights of the weighted pillars, out of 100. */
export const WEIGHTS: Record<WeightedPillar, number> = {
  maturity: 25,
  popularity: 25,
  vitality: 20,
  issues: 10,
  community: 20,
};

/**
 * Influence is rare (most entries have no catalog entries built on them), so it
 * adds up to this many points instead of weighing on everyone's average.
 */
export const INFLUENCE_BONUS = 15;

export const PILLAR_LABELS: Record<Pillar, string> = {
  maturity: 'Maturity',
  popularity: 'Popularity',
  vitality: 'Vitality',
  issues: 'Issue health',
  influence: 'Influence',
  community: 'Community',
};

/**
 * Caps for norm(); a value at or above its threshold scores 1. Set between the
 * 95th and 99th percentile of the 2026-11-09 snapshot (2,380 entries with
 * GitHub data), so the top projects still separate from merely popular ones.
 */
export const THRESHOLDS = {
  ageYears: 10,
  releases: 20,
  commits: 600,
  stars: 500,
  /** Forks plus active forks (an active fork counts twice). */
  forks: 100,
  watchers: 30,
  commitsLastYear: 300,
  /** Influence: sum of catalog children's base scores (each 0–1). */
  childScore: 3,
  contributors: 15,
  busFactor: 3,
  discussions: 50,
} as const;

/** Relative weights of the signals inside each pillar. */
export const SIGNAL_WEIGHTS = {
  maturity: { age: 2, releases: 1.5, commits: 1.5, stable: 0.5 },
  popularity: { stars: 2, forks: 1, watchers: 1 },
  vitality: { commitsLastYear: 1, recency: 1 },
  issues: { issues: 0.75, prs: 0.25 },
  community: { contributors: 2, busFactor: 1 },
} as const;
/** Community = min(1, CORE·(contributors and bus factor) + BONUS·max(Discussions, community link)). */
export const COMMUNITY_CORE = 0.8;
export const COMMUNITY_BONUS = 0.3;
/** Display bands: a score at or above each lower bound. */
export const TIERS = { high: 70, mid: 45, low: 25 } as const;

/**
 * Public ratings, best first. The numeric score stays internal: it sorts lists
 * and gates ratings, but is never shown. One rating per entry, the first rule
 * that matches (see `rate`).
 */
export const RATINGS = ['foundational', 'established', 'rising', 'notable'] as const;
export type Rating = (typeof RATINGS)[number];

export const RATING_LABELS: Record<Rating, string> = {
  foundational: 'Foundational',
  established: 'Established',
  rising: 'Rising',
  notable: 'Notable',
};

/** One-line meaning of each rating, for titles and the methodology page. */
export const RATING_DESCRIPTIONS: Record<Rating, string> = {
  foundational: "Other projects build on it, or it is the maker's own open firmware or SDK.",
  established: 'Mature and widely used.',
  rising: 'Under a year old, with real traction.',
  notable: 'Stands out from most entries, without a clearer category.',
};

/** Entries scoring below this, or without GitHub data, get no public rating: not enough data. */
export const MIN_RATED_SCORE = 48;

export const RATING_RULES = {
  /** Foundational: at least this many catalog entries derive from it… */
  foundationalChildren: 3,
  /** …or an influence pillar at least this high. */
  foundationalInfluence: 0.6,
  /** Established: maturity and popularity pillars at least these. */
  establishedMaturity: 0.5,
  establishedPopularity: 0.4,
  /** Rising: younger than this many years. */
  risingMaxYears: 1,
} as const;

/** Tags that mark a tool as an SDK or library others build with. */
export const SDK_TAGS = ['sdk', 'library'] as const;

/**
 * The device maker's own open-source firmware or SDK: Foundational whatever its
 * score, since that is what everything else on the device builds on.
 */
export function isFirstPartyFoundation(input: Pick<QualityInput, 'kind' | 'source_status' | 'tags'>, firstParty: boolean): boolean {
  if (!firstParty || input.source_status !== 'open') return false;
  return (input.kind ?? 'firmware') === 'firmware' || input.tags.some((t) => (SDK_TAGS as readonly string[]).includes(t));
}

/** The public rating for a score, or undefined when there is not enough data. */
export function rate(q: Pick<Quality, 'score' | 'pillars' | 'limited' | 'facts'>): Rating | undefined {
  if (q.limited || q.score < MIN_RATED_SCORE) return undefined;
  const R = RATING_RULES;
  const p = q.pillars;
  if (q.facts.childIds.length >= R.foundationalChildren || (p.influence ?? 0) >= R.foundationalInfluence) return 'foundational';
  if ((p.maturity ?? 0) >= R.establishedMaturity && (p.popularity ?? 0) >= R.establishedPopularity) return 'established';
  if ((q.facts.ageYears ?? Infinity) < R.risingMaxYears) return 'rising';
  return 'notable';
}

/**
 * Points added to the computed score of a first-party entry: one tagged
 * `official`, or with an author whose name is the device's manufacturer.
 * Capped at 100.
 */
export const FIRST_PARTY_BONUS = 10;

/** Months without a commit or release after which recency reaches 0. */
export const RECENCY_MONTHS = 24;
/** Smoothing for issue and PR ratios: (n·x + K·PRIOR) / (n + K). Also the neutral score when there are none. */
export const RATIO_PRIOR = 0.6;
export const RATIO_K = 10;
/**
 * Finished-project rule: a quiet project that is not archived, at least
 * FINISHED_MIN_YEARS old, and either mature or adopted (maturity, or the larger
 * of popularity and influence, at least FINISHED_MIN) gets vitality of at
 * least FINISHED_SHARE × the larger of the two.
 */
export const FINISHED_MIN = 0.5;
export const FINISHED_MIN_YEARS = 3;
export const FINISHED_SHARE = 0.7;

/** Applies the finished-project rule to a raw vitality. */
function finishedRule(
  vitality: number,
  o: { archived: boolean; ageYears?: number; maturity: number; adoption: number },
): { vitality: number; finished: boolean } {
  const basis = Math.max(o.maturity, o.adoption);
  const eligible = !o.archived && (o.ageYears ?? 0) >= FINISHED_MIN_YEARS && basis >= FINISHED_MIN;
  return eligible && FINISHED_SHARE * basis > vitality
    ? { vitality: FINISHED_SHARE * basis, finished: true }
    : { vitality, finished: false };
}

const SW = SIGNAL_WEIGHTS;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const MONTH_MS = YEAR_MS / 12;
const DAY_MS = 24 * 60 * 60 * 1000;
/** `main @ 1a2b3c4` versions track a branch head; they are not releases. */
const COMMIT_VERSION = /^\S+ @ [0-9a-f]{7,40}$/i;

export function norm(value: number, threshold: number): number {
  if (!(value > 0)) return 0;
  return Math.log1p(value) / Math.log1p(Math.max(value, threshold));
}

function smoothRatio(hits: number, total: number): number {
  return (hits + RATIO_K * RATIO_PRIOR) / (total + RATIO_K);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function weightedMean(parts: [number, number][]): number {
  const w = parts.reduce((s, [, wt]) => s + wt, 0);
  return w ? parts.reduce((s, [v, wt]) => s + v * wt, 0) / w : 0;
}

/** A hand-set score with the reason for it. */
export interface QualityOverride {
  score: number;
  reason: string;
}

/** The fields of a catalog entry the index reads. */
export interface QualityInput {
  /** `<device>/<slug>` */
  id: string;
  /** Primary device first, then also_devices. */
  deviceIds: string[];
  source?: string;
  status: Status;
  versions: { version: string; date?: Date }[];
  based_on?: string;
  community: { url: string }[];
  authors: { name: string }[];
  tags: string[];
  /** 'firmware' or 'tool'. */
  kind?: string;
  source_status?: string;
  /** The entry's `quality` field: a hand-set score with a reason, and/or `hide`. */
  quality?: { score?: number; reason?: string; hide?: boolean; rating?: Rating };
}

/** The fields of a device the index reads. */
export interface QualityDevice {
  manufacturer: string;
  /** The device's community links; they count toward a shared device-level score. */
  community: { url: string }[];
  quality?: {
    /** Entries whose source is in this repo share one score, computed for the repo itself. */
    shared_repo?: string;
    /** Hand-set device-level score: replaces the shared score, or applies to every entry whose primary device this is. */
    score?: number;
    reason?: string;
    /** Show no quality score for any entry whose primary device this is. */
    hide?: boolean;
    /** Hand-set rating for the device-level score (and the entries that share it). */
    rating?: Rating;
  };
}

/** Tagged `official`, or an author's name is the device's manufacturer. */
export function isFirstParty(input: Pick<QualityInput, 'tags' | 'authors'>, manufacturer: string | undefined): boolean {
  if (input.tags.includes('official')) return true;
  const m = manufacturer ? slugify(manufacturer) : '';
  return !!m && input.authors.some((a) => slugify(a.name) === m);
}

/** The raw numbers behind the pillars, for display. */
export interface QualityFacts {
  ageYears?: number;
  releases: number;
  commits?: number;
  commitsLastYear?: number;
  /** Newest commit, release or dated catalog version (ISO date). */
  lastActivity?: string;
  stars?: number;
  forks?: number;
  watchers?: number;
  /** Forks with real work (stars, or pushed to after forking), among the top 100 by stars. */
  activeForks?: number;
  issuesOpen?: number;
  issuesClosed?: number;
  prsMerged?: number;
  prsTotal?: number;
  contributors?: number;
  busFactor?: number;
  discussions?: number;
  communityLinks: number;
  archived: boolean;
  /** GitHub fork parent (owner/repo), when the repo is a fork. */
  forkOf?: string;
  /** The catalog entry this one derives from (GitHub fork parent or `based_on`). */
  parentId?: string;
  /** Catalog entries derived from this one. */
  childIds: string[];
  /** Quiet but mature or widely adopted: vitality was raised by the finished-project rule. */
  finished: boolean;
  /** Vitality before the finished-project rule. */
  rawVitality: number;
}

export interface Quality {
  /** 0–100: the computed score, plus the first-party bonus, unless an override replaces it. */
  score: number;
  /** The weighted pillars plus the influence bonus, 0–100, before the first-party bonus or any override. */
  computed: number;
  /** Earned the first-party bonus. */
  firstParty: boolean;
  /** A hand-set score that replaced the computed one: the entry's `quality.score` or its device's. */
  override?: QualityOverride & { level: 'entry' | 'device' };
  /** `quality.hide` on the entry or its device: still sorts by score, but shows none. */
  hidden: boolean;
  /** Public rating; undefined when there is not enough data (score below MIN_RATED_SCORE or no GitHub data). */
  rating?: Rating;
  /** Scored once for the whole device: the entry's source is in the device's `quality.shared_repo`. */
  shared?: { deviceId: string; repo: string; members: number };
  /** Each 0–1; null when the entry has no data for it (the score imputes the catalog median). */
  pillars: Record<Pillar, number | null>;
  /** No GitHub data: some pillars are imputed. */
  limited: boolean;
  /** Per listing device: 1 + the number of that device's entries scoring higher, out of `of`. */
  rank: Record<string, { rank: number; of: number }>;
  facts: QualityFacts;
}

interface Resolved {
  input: QualityInput;
  repo?: RepoMetrics;
  path?: PathMetrics;
  repoKey?: string;
  pathName?: string;
}

/** Map from lower-case current and original repo names to snapshot keys. */
function repoNameIndex(snapshot: MetricsSnapshot | null): Map<string, string> {
  const idx = new Map<string, string>();
  if (!snapshot) return idx;
  for (const [key, r] of Object.entries(snapshot.repos)) {
    idx.set(key, key);
    idx.set(r.name.toLowerCase(), key);
  }
  return idx;
}

/** Catalog parent of each entry: `based_on` first, then the GitHub fork parent. */
function resolveParents(entries: Resolved[], snapshot: MetricsSnapshot | null): Map<string, string> {
  const ids = new Set(entries.map((e) => e.input.id));
  const names = repoNameIndex(snapshot);
  const byRepo = new Map<string, Resolved[]>();
  for (const e of entries) {
    if (!e.repoKey) continue;
    const list = byRepo.get(e.repoKey) ?? [];
    list.push(e);
    byRepo.set(e.repoKey, list);
  }
  /** One entry in `repoKey` that `child` derives from, or undefined when it can't be told. */
  const pick = (repoKey: string, child: Resolved): string | undefined => {
    const candidates = (byRepo.get(repoKey) ?? []).filter((c) => c.input.id !== child.input.id);
    if (candidates.length <= 1) return candidates[0]?.input.id;
    const samePath = candidates.filter((c) => c.pathName && c.pathName === child.pathName);
    if (samePath.length === 1) return samePath[0].input.id;
    const pool = samePath.length ? samePath : candidates;
    const sameDevice = pool.filter((c) => c.input.deviceIds.some((d) => child.input.deviceIds.includes(d)));
    return sameDevice.length === 1 ? sameDevice[0].input.id : undefined;
  };

  const parents = new Map<string, string>();
  for (const e of entries) {
    let parent: string | undefined;
    const b = e.input.based_on;
    if (b) {
      if (ids.has(b)) parent = b;
      else {
        const gh = parseGithubSource(b);
        const key = gh && names.get(gh.key) ? names.get(gh.key) : gh?.key;
        if (key) parent = pick(key, e);
      }
    } else if (e.repo?.parent) {
      const key = names.get(e.repo.parent.toLowerCase()) ?? e.repo.parent.toLowerCase();
      parent = pick(key, e);
    }
    if (parent && parent !== e.input.id) parents.set(e.input.id, parent);
  }
  return parents;
}

function isoDay(d: Date | undefined): string | undefined {
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : undefined;
}

function maxDate(...ds: (Date | string | undefined)[]): Date | undefined {
  let best: Date | undefined;
  for (const x of ds) {
    if (!x) continue;
    const d = typeof x === 'string' ? new Date(x) : x;
    if (!Number.isNaN(d.getTime()) && (!best || d > best)) best = d;
  }
  return best;
}

/** Everything but influence, which needs the other entries' scores first. */
function scoreOwn(e: Resolved, now: Date): { pillars: Record<Pillar, number | null>; facts: QualityFacts } {
  const { input, repo, path } = e;
  const dated = input.versions.filter((v) => v.date && !Number.isNaN(v.date.getTime()));
  const catalogReleases = input.versions.filter((v) => !COMMIT_VERSION.test(v.version)).length;
  const oldestVersion = dated.reduce<Date | undefined>((o, v) => (!o || v.date! < o ? v.date : o), undefined);
  const newestVersion = maxDate(...dated.map((v) => v.date));
  const archived = input.status === 'archived' || !!repo?.archived;
  const communityLinks = input.community.length;
  const links = communityLinks ? 1 : 0;

  if (!repo) {
    // Limited data: catalog fields only.
    const ageYears = oldestVersion ? (now.getTime() - oldestVersion.getTime()) / YEAR_MS : undefined;
    const maturity = weightedMean([
      [norm(ageYears ?? 0, THRESHOLDS.ageYears), SW.maturity.age],
      [norm(catalogReleases, THRESHOLDS.releases), SW.maturity.releases],
    ]);
    let vitality: number;
    if (archived) vitality = 0;
    else if (newestVersion) vitality = clamp01(1 - (now.getTime() - newestVersion.getTime()) / MONTH_MS / RECENCY_MONTHS);
    else vitality = { active: 0.6, maintained: 0.5, dormant: 0.2, archived: 0, announced: 0.3, unknown: 0.3 }[input.status];
    const rawVitality = vitality;
    let finished: boolean;
    ({ vitality, finished } = finishedRule(vitality, { archived, ageYears, maturity, adoption: 0 }));
    return {
      pillars: {
        maturity,
        popularity: null,
        vitality,
        issues: null,
        influence: 0,
        community: links ? 0.3 : null,
      },
      facts: {
        ageYears,
        releases: catalogReleases,
        lastActivity: isoDay(newestVersion),
        communityLinks,
        archived,
        childIds: [],
        finished,
        rawVitality,
      },
    };
  }

  const isFork = !!repo.parent;
  const created = new Date(repo.createdAt);
  const ageYears = (now.getTime() - Math.min(created.getTime(), oldestVersion?.getTime() ?? Infinity)) / YEAR_MS;
  const releases = Math.max(repo.releases, catalogReleases);
  const commits = path ? path.commits : isFork ? (repo.ownCommits ?? 0) : repo.commits;
  const commitsLastYear = path ? path.commitsLastYear : repo.commitsLastYear;
  const lastActivity = maxDate(path ? path.lastCommit : repo.lastCommit, repo.latestRelease, newestVersion);

  const maturity = weightedMean([
    [norm(ageYears, THRESHOLDS.ageYears), SW.maturity.age],
    [norm(releases, THRESHOLDS.releases), SW.maturity.releases],
    [norm(commits, THRESHOLDS.commits), SW.maturity.commits],
    [repo.stableRelease ? 1 : 0, SW.maturity.stable],
  ]);

  // Active forks (stars, or pushed to more than a day after forking; the useful-forks rule)
  // count twice: once in the fork total and once more here.
  const activeForks = repo.topForks.filter(
    (f) => f.stars > 0 || new Date(f.pushedAt).getTime() - new Date(f.createdAt).getTime() > DAY_MS,
  ).length;
  const popularity = weightedMean([
    [norm(repo.stars, THRESHOLDS.stars), SW.popularity.stars],
    [norm(repo.forks + activeForks, THRESHOLDS.forks), SW.popularity.forks],
    [norm(repo.watchers, THRESHOLDS.watchers), SW.popularity.watchers],
  ]);

  const recency = lastActivity ? clamp01(1 - (now.getTime() - lastActivity.getTime()) / MONTH_MS / RECENCY_MONTHS) : 0;
  let vitality = archived ? 0 : weightedMean([
        [norm(commitsLastYear, THRESHOLDS.commitsLastYear), SW.vitality.commitsLastYear],
        [recency, SW.vitality.recency],
      ]);
  const rawVitality = vitality;
  let finished: boolean;
  ({ vitality, finished } = finishedRule(vitality, { archived, ageYears, maturity, adoption: popularity }));

  const issuesTotal = repo.issuesOpen + repo.issuesClosed;
  const issueRatio = repo.hasIssues && issuesTotal ? smoothRatio(repo.issuesClosed, issuesTotal) : RATIO_PRIOR;
  const prRatio = repo.prsTotal ? smoothRatio(repo.prsMerged, repo.prsTotal) : RATIO_PRIOR;
  const issues = weightedMean([[issueRatio, SW.issues.issues], [prRatio, SW.issues.prs]]);

  const contributors = isFork ? (repo.ownAuthors ?? 0) : repo.contributors;
  // A fork's bus factor is its parent's; count it only when the fork has its own authors.
  const busFactor = isFork ? Math.min(repo.busFactor, contributors) : repo.busFactor;
  const discussions = repo.hasDiscussions ? norm(repo.discussions, THRESHOLDS.discussions) : 0;
  const core = weightedMean([
    [norm(contributors, THRESHOLDS.contributors), SW.community.contributors],
    [norm(busFactor, THRESHOLDS.busFactor), SW.community.busFactor],
  ]);
  const community = Math.min(1, COMMUNITY_CORE * core + COMMUNITY_BONUS * Math.max(discussions, links));

  return {
    pillars: { maturity, popularity, vitality, issues, influence: 0, community },
    facts: {
      ageYears,
      releases,
      commits,
      commitsLastYear,
      lastActivity: isoDay(lastActivity),
      stars: repo.stars,
      forks: repo.forks,
      watchers: repo.watchers,
      activeForks,
      issuesOpen: repo.hasIssues ? repo.issuesOpen : undefined,
      issuesClosed: repo.hasIssues ? repo.issuesClosed : undefined,
      prsMerged: repo.prsMerged,
      prsTotal: repo.prsTotal,
      contributors,
      busFactor,
      discussions: repo.hasDiscussions ? repo.discussions : undefined,
      communityLinks,
      archived,
      forkOf: repo.parent,
      childIds: [],
      finished,
      rawVitality,
    },
  };
}

/** Weighted composite over the given pillars, imputing `fallback` for null ones. */
/** Weighted average of the weighted pillars (0–1), imputing `fallback` for null ones. Influence is not part of it. */
function composite(pillars: Record<Pillar, number | null>, fallback: Record<Pillar, number>): number {
  let sum = 0;
  let w = 0;
  for (const p of Object.keys(WEIGHTS) as WeightedPillar[]) {
    sum += (pillars[p] ?? fallback[p]) * WEIGHTS[p];
    w += WEIGHTS[p];
  }
  return w ? sum / w : 0;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Scores every entry. Pass the whole catalog: influence and ranks
 * depend on the other entries.
 */
/** A score that belongs to a whole device: a shared-repo score and/or a hand-set device score. */
export interface DeviceQuality {
  score: number;
  /** Public rating of the device-level score; undefined when there is not enough data. */
  rating?: Rating;
  /** Entries in the device's `quality.shared_repo`, with the repo's breakdown. */
  shared?: { repo: string; members: number; quality: Quality };
  override?: QualityOverride;
}

export interface QualityResult {
  /** By entry id. */
  entries: Map<string, Quality>;
  /** By device id, for devices with a device-level score that is not hidden. */
  devices: Map<string, DeviceQuality>;
}

export function computeQuality(
  entries: QualityInput[],
  snapshot: MetricsSnapshot | null,
  devices: Record<string, QualityDevice> = {},
  buildDate = new Date(),
): QualityResult {
  const now = snapshot ? new Date(snapshot.fetchedAt) : buildDate;

  // A device with a shared_repo is scored once, as a synthetic entry for the repo itself;
  // its member entries take that score.
  const sharedOf = new Map<string, { deviceId: string; syntheticId: string; repo: string }>();
  const synthetic: QualityInput[] = [];
  for (const [deviceId, d] of Object.entries(devices)) {
    const gh = parseGithubSource(d.quality?.shared_repo);
    if (!gh) continue;
    const members = entries.filter((e) => e.deviceIds[0] === deviceId && parseGithubSource(e.source)?.key === gh.key);
    if (!members.length) continue;
    const syntheticId = `device:${deviceId}`;
    for (const m of members) sharedOf.set(m.id, { deviceId, syntheticId, repo: `${gh.owner}/${gh.repo}` });
    synthetic.push({
      id: syntheticId,
      deviceIds: [],
      source: `https://github.com/${gh.owner}/${gh.repo}`,
      status: 'active',
      versions: members.flatMap((m) => m.versions),
      community: d.community,
      authors: [],
      tags: [],
    });
  }
  const inputs = [...entries, ...synthetic];

  const resolved: Resolved[] = inputs.map((input) => {
    const gh = parseGithubSource(input.source);
    return {
      input,
      repoKey: gh?.key,
      pathName: gh?.path,
      repo: gh ? snapshot?.repos[gh.key] : undefined,
      path: gh?.pathKey ? snapshot?.paths[gh.pathKey] : undefined,
    };
  });

  // Each record is measured from its own fetch time; older records have none and use the snapshot's.
  const at = (e: Resolved) => e.path?.fetchedAt ?? e.repo?.fetchedAt;
  const own = new Map(resolved.map((e) => [e.input.id, scoreOwn(e, at(e) ? new Date(at(e)!) : now)]));

  // Missing pillars take the median of entries that have them.
  const fallback = Object.fromEntries(
    PILLARS.map((p) => [p, median([...own.values()].map((o) => o.pillars[p]).filter((v): v is number => v !== null))]),
  ) as Record<Pillar, number>;

  // Influence: catalog entries built on this one (GitHub fork parent or `based_on`), each
  // weighted by the child's score without its own influence (one level deep).
  const parents = resolveParents(resolved, snapshot);
  const childScore = new Map<string, number>();
  for (const [child, parent] of parents) {
    const c = own.get(child)!;
    childScore.set(parent, (childScore.get(parent) ?? 0) + composite(c.pillars, fallback));
    own.get(parent)?.facts.childIds.push(child);
    c.facts.parentId = parent;
  }

  const out = new Map<string, Quality>();
  for (const e of resolved) {
    const o = own.get(e.input.id)!;
    const influence = norm(childScore.get(e.input.id) ?? 0, THRESHOLDS.childScore);
    // Re-apply the finished-project rule now that influence is known.
    const f = finishedRule(o.facts.rawVitality, {
      archived: o.facts.archived,
      ageYears: o.facts.ageYears,
      maturity: o.pillars.maturity ?? 0,
      adoption: Math.max(o.pillars.popularity ?? 0, influence),
    });
    o.facts.finished = f.finished;
    const pillars = { ...o.pillars, vitality: f.vitality, influence };
    const computed = Math.round(Math.min(100, composite(pillars, fallback) * 100 + INFLUENCE_BONUS * influence));
    const primary = e.input.deviceIds[0];
    const firstParty = isFirstParty(e.input, primary ? devices[primary]?.manufacturer : undefined);
    out.set(e.input.id, {
      score: firstParty ? Math.min(100, computed + FIRST_PARTY_BONUS) : computed,
      computed,
      firstParty,
      hidden: false,
      pillars,
      limited: !e.repo,
      rank: {},
      facts: o.facts,
    });
  }

  // Shared device-level scores replace their members' own, then hand-set overrides
  // apply: the device's score, then the entry's own, which wins.
  const memberCount = new Map<string, number>();
  for (const s of sharedOf.values()) memberCount.set(s.syntheticId, (memberCount.get(s.syntheticId) ?? 0) + 1);
  for (const e of entries) {
    const s = sharedOf.get(e.id);
    let q = out.get(e.id)!;
    if (s) {
      const dev = out.get(s.syntheticId)!;
      q = { ...dev, rank: {}, shared: { deviceId: s.deviceId, repo: s.repo, members: memberCount.get(s.syntheticId)! } };
    }
    const dq = devices[e.deviceIds[0]]?.quality;
    if (dq?.score !== undefined && (!dq.shared_repo || s)) {
      q = { ...q, score: dq.score, override: { score: dq.score, reason: dq.reason ?? '', level: 'device' } };
    }
    const own = e.quality;
    if (own?.score !== undefined) q = { ...q, score: own.score, override: { score: own.score, reason: own.reason ?? '', level: 'entry' } };
    q = { ...q, hidden: !!(dq?.hide || own?.hide) };
    // A hand-set rating wins; the device's applies to shared entries, or to all when it has no shared repo.
    const deviceRating = dq?.rating && (!dq.shared_repo || s) ? dq.rating : undefined;
    const foundation = !s && isFirstPartyFoundation(e, q.firstParty) ? 'foundational' : undefined;
    q = { ...q, rating: own?.rating ?? deviceRating ?? foundation ?? rate(q) };
    out.set(e.id, q);
  }

  const deviceScores = new Map<string, DeviceQuality>();
  for (const [deviceId, d] of Object.entries(devices)) {
    const dq = d.quality;
    if (!dq || dq.hide) continue;
    const syntheticId = `device:${deviceId}`;
    const sq = out.get(syntheticId);
    const members = memberCount.get(syntheticId);
    const shared = sq && members ? { repo: [...sharedOf.values()].find((x) => x.syntheticId === syntheticId)!.repo, members, quality: sq } : undefined;
    const override = dq.score !== undefined ? { score: dq.score, reason: dq.reason ?? '' } : undefined;
    if (!shared && !override) continue;
    const score = override?.score ?? shared!.quality.score;
    const rating = dq.rating ?? (shared ? rate({ ...shared.quality, score }) : undefined);
    deviceScores.set(deviceId, { score, rating, shared, override });
  }
  for (const s of synthetic) out.delete(s.id);
  const resolvedEntries = resolved.filter((r) => !r.input.id.startsWith('device:'));

  // Rank within each listing device (hidden stale entries included).
  const byDevice = new Map<string, number[]>();
  for (const e of resolvedEntries) {
    for (const d of e.input.deviceIds) {
      const list = byDevice.get(d) ?? [];
      list.push(out.get(e.input.id)!.score);
      byDevice.set(d, list);
    }
  }
  for (const e of resolvedEntries) {
    const q = out.get(e.input.id)!;
    for (const d of e.input.deviceIds) {
      const scores = byDevice.get(d)!;
      q.rank[d] = { rank: 1 + scores.filter((s) => s > q.score).length, of: scores.length };
    }
  }
  return { entries: out, devices: deviceScores };
}

/** An aggregate device score averages this many of the device's best-scoring entries. */
export const AGGREGATE_TOP = 5;

/** A device without a device-level score, summarised from its entries' scores. */
export interface DeviceAggregate {
  /** Mean of the best AGGREGATE_TOP entry scores (all of them when there are fewer), rounded. */
  score: number;
  /** Ids of the entries averaged, best first. */
  top: string[];
  /** Entries with a shown score. */
  count: number;
  /** Mean of the best 10% of entries (at least one), and how many that is. */
  top10: { n: number; score: number };
  /** Mean of every entry with a shown score. */
  all: number;
  /** Entries per public rating; `unrated` have not enough data. */
  ratings: Record<Rating | 'unrated', number>;
  median: number;
  tiers: Record<ReturnType<typeof qualityTier>, number>;
}

/**
 * Aggregates entry scores into one device score. The best entries, not all of
 * them: a device's long tail of small forks says little about what it offers.
 */
export function aggregateQuality(entries: { id: string; score: number; rating?: Rating }[]): DeviceAggregate | undefined {
  if (!entries.length) return undefined;
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, AGGREGATE_TOP);
  const mean = (xs: { score: number }[]) => Math.round(xs.reduce((s, e) => s + e.score, 0) / xs.length);
  const n10 = Math.max(1, Math.ceil(entries.length / 10));
  const tiers = { high: 0, mid: 0, low: 0, minimal: 0 };
  for (const e of entries) tiers[qualityTier(e.score)]++;
  const ratings = { foundational: 0, established: 0, rising: 0, notable: 0, unrated: 0 };
  for (const e of entries) ratings[e.rating ?? 'unrated']++;
  return {
    score: mean(top),
    top: top.map((e) => e.id),
    count: entries.length,
    top10: { n: n10, score: mean(sorted.slice(0, n10)) },
    all: mean(entries),
    ratings,
    median: Math.round(median(entries.map((e) => e.score))),
    tiers,
  };
}

/** Display band for a score. */
export function qualityTier(score: number): 'high' | 'mid' | 'low' | 'minimal' {
  return score >= TIERS.high ? 'high' : score >= TIERS.mid ? 'mid' : score >= TIERS.low ? 'low' : 'minimal';
}
