/**
 * Build-time content loader for the Music Thing Workshop System Computer
 * program cards.
 *
 * Reads every `releases/<card>/info.yaml` from TomWhitwell/Workshop_Computer
 * (branch main) and turns each into a `firmwares` entry with id
 * `music-thing-workshop-computer/<slug>`. Nothing is written to the repo; the
 * entries live in Astro's data store and are rebuilt on each `astro build` /
 * `astro dev` start.
 *
 * Network behaviour:
 *   - One GitHub API call lists the card directories. Its ETag is kept in the
 *     loader meta store, so an unchanged upstream answers 304 (which does not
 *     count against the unauthenticated rate limit) and the cached entries are
 *     reused without fetching 133 info.yaml files again.
 *   - Set GITHUB_TOKEN to raise the API rate limit (CI does this).
 *   - Set ALTSTRUMENT_SKIP_REMOTE=1 to skip the remote fetch entirely
 *     (offline development). Cached entries from a previous run are reused if
 *     the data store has them; otherwise the device simply lists no cards.
 *   - A network failure on the directory listing with no cache fails the build,
 *     so a broken upstream is never silently published as an empty device page.
 *   - A single card's info.yaml fetch that fails (network error after retries,
 *     or an HTTP status other than 200/404 such as 403) does not fail the build:
 *     the cached entry for that card is kept if there is one, otherwise the card
 *     is skipped with a warning. The listing ETag is then not saved, so the next
 *     build refetches instead of getting a 304 that would freeze the fallbacks.
 *   - A card's `demo-link`, when it is a YouTube URL, is checked against
 *     YouTube's oEmbed endpoint: a removed or non-embeddable video is dropped,
 *     a live one supplies the title and channel. A network failure keeps the
 *     link without them.
 *
 * Slug rule (mirrors tools/sitegen in the upstream repo, `slugify(folderName)`):
 *   lowercase, every run of characters outside [a-z0-9] becomes "-", then
 *   leading/trailing "-" are trimmed. `03_Turing_Machine` -> `03-turing-machine`.
 */
import type { Loader, LoaderContext } from 'astro/loaders';
import type { DataEntry } from 'astro:content';
import { parse } from 'yaml';
import { LICENSES, type License } from '../content/schema';
import { youtubeId, youtubeOembedUrl } from '../lib/media';

export const DEVICE = 'music-thing-workshop-computer';
const ID_PREFIX = `${DEVICE}/`;

const REPO = 'TomWhitwell/Workshop_Computer';
const BRANCH = 'main';
const LIST_URL = `https://api.github.com/repos/${REPO}/contents/releases?ref=${BRANCH}`;
const rawUrl = (dir: string) =>
  `https://raw.githubusercontent.com/${REPO}/${BRANCH}/releases/${encodeURIComponent(dir)}/info.yaml`;
const treeUrl = (dir: string) =>
  `https://github.com/${REPO}/tree/${BRANCH}/releases/${encodeURIComponent(dir)}`;
const programUrl = (slug: string) => `https://computer.musicthing.co.uk/programs/${slug}/`;

const CONCURRENCY = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const DRAFT_PREFIX = 'Draft listing upstream (info.yaml draft: true). ';
/**
 * Bump when buildEntry's mapping changes, so a cached listing ETag from the old
 * mapping no longer matches and the cards are rebuilt.
 */
const MAPPING_VERSION = 3;
const META_ETAG = `workshop-computer:listing-etag:v${MAPPING_VERSION}`;

// ---- helpers ---------------------------------------------------------------


class NetworkError extends Error {}

/** Same rule as tools/sitegen/src/utils/strings.js `slugify`. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

async function fetchRaw(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; etag?: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'altstrument-loader', ...headers },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return { status: res.status, body: await res.text(), etag: res.headers.get('etag') ?? undefined };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new NetworkError(`${url}: ${(lastErr as Error)?.message ?? lastErr}`);
}

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

/** Lowercase keys with spaces/hyphens/underscores removed (upstream does the same). */
function normalizeKeys(obj: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) out[k.toLowerCase().replace(/[\s_-]+/g, '')] = v;
  }
  return out;
}

const text = (v: unknown): string =>
  v === undefined || v === null || typeof v === 'object' ? '' : String(v).trim();

function isoDate(v: unknown): string | undefined {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(text(v));
  return m ? m[1] : undefined;
}

function httpUrl(v: unknown): string | undefined {
  const s = text(v);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function truthy(v: unknown): boolean {
  if (v === true || v === 1) return true;
  return ['true', 'yes', '1'].includes(text(v).toLowerCase());
}

/** Collapse all whitespace, cap at 280 chars on a word boundary, end with a sentence stop. */
function toSummary(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length > 280) {
    s = s.slice(0, 279);
    const sp = s.lastIndexOf(' ');
    if (sp > 0) s = s.slice(0, sp);
    s = s.replace(/[\s.,;:!?-]+$/, '');
  }
  if (!/[.!?]$/.test(s)) s += '.';
  if (s.length > 280) s = s.slice(0, 280);
  return s;
}

function firstSentence(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  const m = /^.*?[.!?](?=\s|$)/.exec(flat);
  return m ? m[0] : flat;
}

/** Trim; keep blank-line paragraph breaks; unwrap hard-wrapped lines inside a paragraph (lists stay as lines). */
function toDescription(raw: string): string {
  const paragraphs = raw
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((p) => {
      const lines = p.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.some((l) => /^([-*•]|\d+[.)])\s/.test(l))) return lines.join('\n');
      return lines.join(' ');
    })
    .filter(Boolean);
  return paragraphs.join('\n\n');
}

// ---- status / license / tags ------------------------------------------------

type StatusValue = 'active' | 'maintained' | 'archived' | 'unknown';

function mapStatus(status: string, updated: string | undefined, now: number): StatusValue {
  const s = status.toLowerCase().replace(/[^a-z]/g, '');
  if (s === 'released') {
    if (updated) {
      const age = now - Date.parse(updated);
      if (age <= 365 * DAY_MS) return 'active';
    }
    return 'maintained';
  }
  if (['beta', 'alpha', 'wip', 'workinprogress', 'experimental'].includes(s)) return 'active';
  if (['deprecated', 'archived', 'retired'].includes(s)) return 'archived';
  return 'unknown';
}

const LICENSE_TABLE: Record<string, License> = {};
function addLicense(id: License, ...aliases: string[]) {
  for (const a of [id as string, ...aliases]) LICENSE_TABLE[licenseKey(a)] = id;
}
/** Case/space/punctuation-insensitive key; keeps "+" because it means "or later". */
function licenseKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+]/g, '');
}
addLicense('GPL-3.0-or-later', 'GPLv3+', 'GPL3+', 'GPL-3.0+', 'GPLv3 or later', 'GPL 3 or later', 'GNU GPL v3 or later');
addLicense('GPL-3.0-only', 'GPL-3.0', 'GPLv3', 'GPL3', 'GPL 3', 'GPL v3', 'GPL-3', 'GNU GPL v3');
addLicense('GPL-2.0-or-later', 'GPLv2+', 'GPL2+', 'GPL-2.0+');
addLicense('GPL-2.0-only', 'GPL-2.0', 'GPLv2', 'GPL2', 'GPL 2');
addLicense('LGPL-2.1-or-later', 'LGPL-2.1', 'LGPLv2.1', 'LGPL 2.1');
addLicense('LGPL-3.0-or-later', 'LGPLv3+', 'LGPL-3.0', 'LGPLv3', 'LGPL3');
addLicense('AGPL-3.0-or-later', 'AGPLv3+');
addLicense('AGPL-3.0-only', 'AGPL-3.0', 'AGPLv3', 'AGPL3');
addLicense('MIT', 'MIT License', 'The MIT License', 'Expat');
addLicense('BSD-2-Clause', 'BSD 2-Clause', 'BSD-2', 'Simplified BSD');
addLicense('BSD-3-Clause', 'BSD 3-Clause', 'BSD-3', 'New BSD', 'Modified BSD');
addLicense('ISC', 'ISC License');
addLicense('Apache-2.0', 'Apache 2.0', 'Apache 2', 'Apache License 2.0', 'Apache License, Version 2.0', 'ASL 2.0');
addLicense('MPL-2.0', 'MPL 2.0', 'Mozilla Public License 2.0');
addLicense('Unlicense', 'The Unlicense', 'Public Domain (Unlicense)');
addLicense('WTFPL');
addLicense('CC0-1.0', 'CC0', 'CC0 1.0', 'CC-0');
addLicense('CC-BY-4.0', 'CC BY 4.0', 'CC BY');
addLicense('CC-BY-SA-4.0', 'CC BY-SA 4.0', 'CC BY SA 4.0', 'CC-BY-SA');
addLicense('CC-BY-NC-4.0', 'CC BY-NC 4.0', 'CC BY NC 4.0', 'CC-BY-NC');
addLicense('CC-BY-NC-SA-4.0', 'CC BY-NC-SA 4.0', 'CC BY NC SA 4.0');
addLicense('CC-BY-SA-3.0', 'CC BY-SA 3.0', 'CC BY SA 3.0');
addLicense('CC-BY-NC-SA-3.0', 'CC BY-NC-SA 3.0', 'CC BY NC SA 3.0', 'CC-BY-NC-SA');
addLicense('PolyForm-Noncommercial-1.0.0', 'PolyForm Noncommercial 1.0.0', 'PolyForm-Noncommercial');
addLicense('Elastic-2.0', 'Elastic License 2.0', 'ELv2');
addLicense('proprietary', 'Commercial', 'Proprietary', 'All rights reserved', 'Closed source');

function mapLicense(raw: string): License | undefined {
  if (!raw) return undefined;
  const hit = LICENSE_TABLE[licenseKey(raw)];
  return hit && (LICENSES as readonly string[]).includes(hit) ? hit : undefined;
}

function normalizeTags(raw: unknown): string[] {
  let items: unknown[] = [];
  if (Array.isArray(raw)) items = raw;
  else if (typeof raw === 'string') items = raw.split(/[,;]+/);
  const out: string[] = [];
  for (const item of items) {
    const tag = text(item)
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

// ---- entry construction -----------------------------------------------------

/** What oEmbed said about a card's demo-link. */
type Demo =
  | { ok: true; url: string; title?: string; credit?: string }
  | { ok: false; url: string; why: string };

interface Card {
  dir: string;
  slug: string;
  url: string;
  info: Record<string, unknown> | null; // null: info.yaml missing
  parseError?: string;
  fetchError?: string; // info.yaml could not be fetched (network error or unexpected HTTP status)
  demo?: Demo;
}

/** Checks a YouTube demo link with oEmbed. Non-YouTube links are reported, not embedded. */
async function checkDemo(raw: unknown): Promise<Demo | undefined> {
  const url = httpUrl(raw);
  if (!url) return undefined;
  if (!youtubeId(url)) return { ok: false, url, why: 'not a YouTube link' };
  try {
    const res = await fetchRaw(youtubeOembedUrl(url));
    if (res.status !== 200) return { ok: false, url, why: `oEmbed HTTP ${res.status}` };
    const o = JSON.parse(res.body) as { title?: unknown; author_name?: unknown };
    return { ok: true, url, title: text(o.title) || undefined, credit: text(o.author_name) || undefined };
  } catch {
    return { ok: true, url }; // unverified: keep the link, skip the metadata
  }
}

interface Built {
  entry: Record<string, unknown>;
  note?: string;
  unmappedLicense?: string;
}

function buildEntry(card: Card, now: number): Built | { skip: string } {
  const info = card.info!;
  const draft = truthy(info.draft);
  const contact = normalizeKeys(info.contact);
  const social = normalizeKeys(contact.social);
  const notes: string[] = [];

  const name = text(info.name) || (notes.push('no Name, used folder name'), card.dir);
  const summaryText = typeof info.summary === 'string' ? info.summary : text(info.summary);
  const short = text(info.shortdescription);
  const summary = toSummary(short || firstSentence(summaryText));
  if (!summary) return { skip: 'no short-description or summary' };

  let description = toDescription(summaryText);
  if (draft) description = (DRAFT_PREFIX + description).trim();

  const updated = isoDate(info.dateupdated);
  const status = mapStatus(text(info.status), updated, now);

  const creator = text(info.creator);
  const names = creator
    .split(/\s*,\s*|\s+&\s+|\s+and\s+/i)
    .map((n) => n.trim())
    .filter(Boolean);
  if (!names.length) return { skip: 'no Creator' };
  const firstUrl = httpUrl(contact.website) ?? httpUrl(social.github);
  const authors = names.map((n, i) => (i === 0 && firstUrl ? { name: n, url: firstUrl } : { name: n }));

  const rawLicense = text(info.license);
  const license = mapLicense(rawLicense) ?? 'unspecified';
  const unmappedLicense = license === 'unspecified' && rawLicense ? rawLicense : undefined;
  const licenseNotes =
    (license === 'unspecified' || license === 'proprietary') && rawLicense
      ? `Upstream info.yaml says: ${rawLicense}`
      : undefined;

  const homepage = programUrl(card.slug);
  const uf2 = info.uf2;
  const hasUf2 = Array.isArray(uf2)
    ? uf2.length > 0
    : uf2 && typeof uf2 === 'object'
      ? Object.keys(uf2).length > 0
      : Boolean(text(uf2));

  const tags = normalizeTags(info.tags);
  for (const extra of ['cards', ...(draft ? ['draft'] : []), ...(httpUrl(info.editor) ? ['editor'] : [])]) {
    if (!tags.includes(extra)) tags.push(extra);
  }

  const version = text(info.version);
  const versions = version
    ? [
        {
          version,
          ...(updated ? { date: updated } : {}),
          url: homepage,
          notes: "Version and date from the card's info.yaml.",
        },
      ]
    : [];

  // Key order follows the schema. Undefined values are dropped by the filter below.
  const entry: Record<string, unknown> = {
    device: DEVICE,
    name,
    kind: 'firmware',
    summary,
    description: description || undefined,
    status,
    authors,
    source: treeUrl(card.dir),
    source_status: 'open',
    license,
    license_notes: licenseNotes,
    homepage,
    distribution: 'download',
    install_notes: hasUf2
      ? "Copy the UF2 onto the Computer's program card (RP2040 bootloader drive)."
      : undefined,
    tags,
    versions: versions.length ? versions : undefined,
    video: card.demo?.ok
      ? { url: card.demo.url, title: card.demo.title, credit: card.demo.credit, first_party: true, found_via: treeUrl(card.dir) }
      : undefined,
    generated_from: card.url,
  };
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];

  return { entry, note: notes.join('; ') || undefined, unmappedLicense };
}

interface Listing {
  dirs: string[];
  etag?: string;
  notModified: boolean;
}

async function listCardDirs(prevEtag?: string): Promise<Listing> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  if (prevEtag) headers['If-None-Match'] = prevEtag;
  const res = await fetchRaw(LIST_URL, headers);
  if (res.status === 304) return { dirs: [], etag: prevEtag, notModified: true };
  if (res.status !== 200) throw new NetworkError(`${LIST_URL}: HTTP ${res.status} ${res.body.slice(0, 200)}`);
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new NetworkError(`${LIST_URL}: response is not JSON`);
  }
  if (!Array.isArray(json)) throw new NetworkError(`${LIST_URL}: unexpected response shape`);
  const dirs = json
    .filter((e): e is { type: string; name: string } => e && e.type === 'dir' && typeof e.name === 'string')
    .map((e) => e.name)
    .sort();
  return { dirs, etag: res.etag, notModified: false };
}

// ---- loader ----------------------------------------------------------------

/** Entries this loader owns: the remote cards, recognisable by their id prefix and generated_from. */
export function snapshotCards(store: LoaderContext['store']): DataEntry[] {
  const out: DataEntry[] = [];
  for (const [id, entry] of store.entries()) {
    if (id.startsWith(ID_PREFIX) && entry.data && (entry.data as Record<string, unknown>).generated_from) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Loads the cards into `store`. `cached` is the snapshot taken before any other
 * loader ran on the same store (the glob loader deletes entries it does not
 * own), used when upstream reports no change or the network is unavailable.
 */
export async function loadWorkshopComputerCards(ctx: LoaderContext, cached: DataEntry[]): Promise<void> {
  const { store, logger, parseData, generateDigest, meta } = ctx;
  const restore = (why: string) => {
    for (const e of cached) store.set(e);
    logger.info(`Workshop Computer cards: ${why}; reused ${cached.length} cached entries`);
  };

  if (process.env.ALTSTRUMENT_SKIP_REMOTE) {
    restore('ALTSTRUMENT_SKIP_REMOTE set');
    return;
  }

  let listing: Listing;
  try {
    listing = await listCardDirs(cached.length ? meta.get(META_ETAG) : undefined);
  } catch (e) {
    if (cached.length) {
      logger.warn(`Workshop Computer cards: ${(e as Error).message}`);
      restore('upstream unreachable');
      return;
    }
    throw new Error(`Workshop Computer cards: upstream unreachable and no cached entries. ${(e as Error).message}`);
  }
  if (listing.notModified) {
    restore('upstream unchanged (304)');
    return;
  }

  const now = Date.now();
  const cards: Card[] = await pool(listing.dirs, CONCURRENCY, async (dir) => {
    const url = rawUrl(dir);
    const base = { dir, slug: slugify(dir), url };
    let status: number;
    let body: string;
    try {
      ({ status, body } = await fetchRaw(url));
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      return { ...base, info: null, fetchError: e.message };
    }
    if (status === 404) return { ...base, info: null };
    if (status !== 200) return { ...base, info: null, fetchError: `${url}: HTTP ${status}` };
    try {
      const doc = parse(body);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        return { ...base, info: null, parseError: 'info.yaml is not a mapping' };
      }
      const info = normalizeKeys(doc);
      return { ...base, info, demo: await checkDemo(info.demolink) };
    } catch (e) {
      return { ...base, info: null, parseError: `YAML parse error: ${(e as Error).message.split('\n')[0]}` };
    }
  });

  let written = 0;
  let kept = 0;
  let fetchErrors = 0;
  const skipped: string[] = [];
  const unmapped = new Map<string, string[]>();
  const byId = new Map(cached.map((e) => [e.id, e]));
  for (const card of cards) {
    if (card.fetchError) {
      fetchErrors++;
      const old = byId.get(ID_PREFIX + card.slug);
      if (old) {
        store.set(old);
        kept++;
        logger.warn(`Workshop Computer cards: ${card.dir}: ${card.fetchError}; kept cached entry`);
      } else {
        skipped.push(`${card.dir}: ${card.fetchError}`);
      }
      continue;
    }
    if (card.info === null) {
      skipped.push(`${card.dir}: ${card.parseError ?? 'no info.yaml'}`);
      continue;
    }
    const built = buildEntry(card, now);
    if ('skip' in built) {
      skipped.push(`${card.dir}: ${built.skip}`);
      continue;
    }
    if (built.unmappedLicense) {
      const list = unmapped.get(built.unmappedLicense) ?? [];
      list.push(card.dir);
      unmapped.set(built.unmappedLicense, list);
    }
    if (card.demo && !card.demo.ok) {
      logger.warn(`Workshop Computer cards: ${card.dir}: demo-link dropped (${card.demo.why}): ${card.demo.url}`);
    }
    const id = ID_PREFIX + card.slug;
    try {
      const data = await parseData({ id, data: built.entry });
      store.set({ id, data, digest: generateDigest(built.entry) });
      written++;
    } catch (e) {
      skipped.push(`${card.dir}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  if (listing.etag && !fetchErrors) meta.set(META_ETAG, listing.etag);
  else if (fetchErrors) {
    logger.warn(`Workshop Computer cards: ${fetchErrors} fetch error(s); listing ETag not saved so the next build refetches`);
  }

  logger.info(
    `Workshop Computer cards: ${written} loaded from ${listing.dirs.length} upstream directories` +
      (kept ? ` (${kept} kept from cache after fetch errors)` : ''),
  );
  for (const s of skipped) logger.warn(`Workshop Computer cards: skipped ${s}`);
  for (const [lic, dirs] of unmapped) {
    logger.warn(`Workshop Computer cards: unmapped license "${lic}" (${dirs.length}): ${dirs.join(', ')}`);
  }
}

/**
 * Composes a file-backed loader with the remote cards in one collection, so
 * device pages, feeds and search treat both the same way.
 */
export function withWorkshopComputerCards(files: Loader): Loader {
  return {
    name: 'firmwares',
    async load(ctx) {
      const cached = snapshotCards(ctx.store);
      await files.load(ctx);
      await loadWorkshopComputerCards(ctx, cached);
    },
  };
}
