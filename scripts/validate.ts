/**
 * Standalone catalog validator.
 *
 * Runs before `astro build` (see package.json) and in CI. It re-parses every
 * YAML file the way Astro does and checks it against the same Zod schemas, then
 * applies cross-file rules
 * Zod cannot express on its own:
 *
 *   - firmware directory name must equal the `device` field
 *   - `device` must point at an existing device file
 *   - `related` device slugs must exist
 *   - `also_devices` slugs must exist, differ from `device`, and not collide
 *     with a file of the same name in the other device's directory
 *   - two files with the same `source` and `summary` are flagged as a likely
 *     duplicate that should be one entry with `also_devices` (warning)
 *   - every device should have at least one firmware or an explanatory `notes`
 *   - file names must be kebab-case slugs
 *   - a video's `version` is in `versions`, and `video` + `videos` follow
 *     the versions order, newest first (warnings)
 *   - every hotlinked `video` / `videos` / `image` still resolves (network; see below),
 *     or only those in the files a pull request changes (ALTSTRUMENT_CHANGED_FILES)
 *
 * Hotlinked-media mode: `--media=strict|soft|off` (env ALTSTRUMENT_MEDIA_CHECK
 * overrides; ALTSTRUMENT_SKIP_REMOTE forces off; default strict; unknown values
 * are an error). strict fails on definitive problems, soft turns every media
 * problem into a warning (for deploys), off skips the network. An image host
 * answering 401/403 is always just a warning. With GITHUB_STEP_SUMMARY set the
 * media results are appended there as markdown; with GITHUB_ACTIONS set each
 * problem is also printed as a workflow annotation.
 *
 * Exit code 1 on any error. Warnings are printed but do not fail the run.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { parse, type ParseOptions, type SchemaOptions } from 'yaml';
import { deviceSchema, firmwareBaseSchema, manufacturerSchema, refineFirmware } from '../src/content/schema';
import { slugify } from '../src/lib/slug';
import { youtubeOembedUrl } from '../src/lib/media';
import { isStale, newestDate } from '../src/lib/stale';
import { z } from 'astro/zod';

const ROOT = new URL('..', import.meta.url).pathname;
const DEVICES_DIR = join(ROOT, 'src/content/devices');
const FIRMWARES_DIR = join(ROOT, 'src/content/firmwares');
const MANUFACTURERS_DIR = join(ROOT, 'src/content/manufacturers');
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const firmwareSchema = refineFirmware(
  firmwareBaseSchema.extend({ device: z.string().regex(SLUG) }),
);

const errors: string[] = [];
const warnings: string[] = [];
const rel = (p: string) => relative(ROOT, p);

function fail(file: string, msg: string) {
  errors.push(`${rel(file)}: ${msg}`);
}
function warn(file: string, msg: string) {
  warnings.push(`${rel(file)}: ${msg}`);
}

function formatIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((i) => `  - ${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`)
    .join('\n');
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

/**
 * Same options as Astro's content loader (@astrojs/internal-helpers/yaml), so an
 * unquoted `version: 2026-04-08` reaches the schema as a Date here too instead
 * of passing as a string and only failing in `astro build`.
 */
const ASTRO_YAML: ParseOptions & SchemaOptions = { customTags: ['timestamp'], merge: true, schema: 'core' };

function loadYaml(file: string): unknown {
  try {
    return parse(readFileSync(file, 'utf8'), ASTRO_YAML);
  } catch (e) {
    fail(file, `YAML parse error: ${(e as Error).message}`);
    return undefined;
  }
}

// ---- symlinks --------------------------------------------------------------
//
// Pull requests come from untrusted forks. A symlink could pull a file from
// outside the repo into the build or public/, or hide an entry from the
// PR-scoped media check, so none are allowed. Stop before reading any YAML:
// a parse error quotes the file it read.

function rejectSymlinks(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) fail(p, 'symlinks are not allowed');
    else if (e.isDirectory()) rejectSymlinks(p);
  }
}
rejectSymlinks(join(ROOT, 'src'));
rejectSymlinks(join(ROOT, 'public'));
if (errors.length) {
  for (const e of errors) console.error(`  x ${e}`);
  console.error('\nCatalog validation failed.');
  process.exit(1);
}

// ---- devices ---------------------------------------------------------------

const deviceSlugs = new Set<string>();
const deviceNotes = new Map<string, string | undefined>();
/** hide_stale_after_years per device, for the stale-entry warning and summary. */
const deviceHideYears = new Map<string, number>();
/** pinned slugs per device, checked against that device's firmware files. */
const devicePinned = new Map<string, string[]>();
const firmwareSlugsByDevice = new Map<string, Set<string>>();
let hiddenTotal = 0;
const deviceRelated = new Map<string, string[]>();
const deviceManufacturers = new Set<string>();

for (const file of listYaml(DEVICES_DIR)) {
  const slug = basename(file).replace(/\.ya?ml$/, '');
  if (!file.endsWith('.yaml')) warn(file, 'use the .yaml extension (not .yml)');
  if (!SLUG.test(slug)) fail(file, `file name "${slug}" is not a kebab-case slug`);
  const raw = loadYaml(file);
  if (raw === undefined) continue;
  const parsed = deviceSchema.safeParse(raw);
  if (!parsed.success) {
    fail(file, `schema errors\n${formatIssues(parsed.error.issues)}`);
    continue;
  }
  deviceSlugs.add(slug);
  deviceNotes.set(slug, parsed.data.notes);
  deviceRelated.set(slug, parsed.data.related);
  if (parsed.data.hide_stale_after_years !== undefined) deviceHideYears.set(slug, parsed.data.hide_stale_after_years);
  if (parsed.data.pinned.length) devicePinned.set(slug, parsed.data.pinned);
  deviceManufacturers.add(parsed.data.manufacturer);
  if (parsed.data.image && !existsSync(join(ROOT, 'public', parsed.data.image.src))) {
    fail(file, `image file ${parsed.data.image.src} does not exist under public/`);
  }
}

// ---- manufacturers ---------------------------------------------------------

let manufacturerTotal = 0;
for (const file of listYaml(MANUFACTURERS_DIR)) {
  const slug = basename(file).replace(/\.ya?ml$/, '');
  const raw = loadYaml(file);
  if (raw === undefined) continue;
  const parsed = manufacturerSchema.safeParse(raw);
  if (!parsed.success) {
    fail(file, `schema errors\n${formatIssues(parsed.error.issues)}`);
    continue;
  }
  const expected = slugify(parsed.data.name);
  if (expected !== slug) fail(file, `file name should be "${expected}.yaml" (slugify of name "${parsed.data.name}")`);
  if (!deviceManufacturers.has(parsed.data.name)) {
    warn(file, `no device uses manufacturer "${parsed.data.name}" (names must match device files exactly)`);
  }
  if (parsed.data.logo && !existsSync(join(ROOT, 'public', parsed.data.logo.src))) {
    fail(file, `logo file ${parsed.data.logo.src} does not exist under public/`);
  }
  manufacturerTotal++;
}

for (const [slug, related] of deviceRelated) {
  for (const r of related) {
    if (!deviceSlugs.has(r)) {
      fail(join(DEVICES_DIR, `${slug}.yaml`), `related device "${r}" does not exist`);
    }
  }
}

// ---- firmwares -------------------------------------------------------------

const firmwareCountByDevice = new Map<string, number>();
/** Entries listed on another device through also_devices: target device -> slug -> file. */
const sharedSlugsByDevice = new Map<string, Map<string, string>>();
/** Files per source URL, for the duplicate-entry warning. */
const filesBySource = new Map<string, { file: string; summary: string }[]>();
let sharedTotal = 0;
/** Hotlinked media to check over the network once the local checks are done. */
const remoteChecks: { file: string; kind: 'video' | 'image'; url: string }[] = [];
let firmwareTotal = 0;

let deviceDirs: string[] = [];
try {
  deviceDirs = readdirSync(FIRMWARES_DIR)
    .map((n) => join(FIRMWARES_DIR, n))
    .filter((p) => statSync(p).isDirectory())
    .sort();
} catch {
  /* no firmwares yet */
}

for (const dir of deviceDirs) {
  const dirSlug = basename(dir);
  if (!deviceSlugs.has(dirSlug)) {
    fail(dir, `firmware directory has no matching device file src/content/devices/${dirSlug}.yaml`);
  }
  const files = listYaml(dir);
  if (files.length === 0) warn(dir, 'empty firmware directory');
  for (const file of files) {
    const fwSlug = basename(file).replace(/\.ya?ml$/, '');
    if (!file.endsWith('.yaml')) warn(file, 'use the .yaml extension (not .yml)');
    if (!SLUG.test(fwSlug)) fail(file, `file name "${fwSlug}" is not a kebab-case slug`);
    const raw = loadYaml(file);
    if (raw === undefined) continue;
    const parsed = firmwareSchema.safeParse(raw);
    if (!parsed.success) {
      fail(file, `schema errors\n${formatIssues(parsed.error.issues)}`);
      continue;
    }
    const fw = parsed.data;
    if (fw.device !== dirSlug) {
      fail(file, `device "${fw.device}" does not match directory "${dirSlug}"`);
    }
    if (!deviceSlugs.has(fw.device)) {
      fail(file, `device "${fw.device}" does not exist`);
    }
    for (const other of fw.also_devices) {
      if (other === fw.device) {
        fail(file, `also_devices lists "${other}", which is already the entry's device`);
      } else if (!deviceSlugs.has(other)) {
        fail(file, `also_devices device "${other}" does not exist`);
      } else {
        if (!sharedSlugsByDevice.has(other)) sharedSlugsByDevice.set(other, new Map());
        const shared = sharedSlugsByDevice.get(other)!;
        const clash = shared.get(fwSlug);
        if (clash) fail(file, `also_devices "${other}": ${rel(clash)} already lists an entry named "${fwSlug}" there`);
        else shared.set(fwSlug, file);
      }
    }
    if (fw.also_devices.length) sharedTotal++;
    if (fw.source) {
      const list = filesBySource.get(fw.source) ?? [];
      list.push({ file, summary: fw.summary });
      filesBySource.set(fw.source, list);
    }
    if (fw.kind === 'firmware' && fw.versions.length === 0 && fw.status !== 'announced') {
      warn(file, 'no versions listed');
    }
    if (fw.license === 'unspecified' && fw.source_status === 'open') {
      warn(file, 'open source but license unspecified; double-check the repo for a LICENSE file');
    }
    const hideYears = deviceHideYears.get(fw.device);
    if (hideYears !== undefined) {
      if (!newestDate(fw.versions)) {
        warn(file, `no dated version, so hide_stale_after_years (${hideYears}) on ${fw.device} can never hide it`);
      } else if (!devicePinned.get(fw.device)?.includes(fwSlug) && isStale(fw, hideYears)) {
        hiddenTotal++;
      }
    }
    // `video` first, then `videos`, newest first: a video's `version` must be
    // listed in versions[] and the order must follow versions[].
    const videos = fw.video ? [fw.video, ...fw.videos] : fw.videos;
    let lastIdx = -1;
    let lastVersion = '';
    for (const v of videos) {
      remoteChecks.push({ file, kind: 'video', url: v.url });
      if (!v.version) continue;
      const idx = fw.versions.findIndex((x) => x.version === v.version);
      if (idx === -1) {
        warn(file, `video ${v.url} names version "${v.version}", which is not in versions`);
      } else if (idx < lastIdx) {
        warn(file, `video for ${v.version} is listed after the one for ${lastVersion}; put the newest release's video first`);
      } else {
        lastIdx = idx;
        lastVersion = v.version;
      }
    }
    if (fw.image) remoteChecks.push({ file, kind: 'image', url: fw.image.url });
    firmwareTotal++;
    firmwareCountByDevice.set(fw.device, (firmwareCountByDevice.get(fw.device) ?? 0) + 1);
    if (!firmwareSlugsByDevice.has(fw.device)) firmwareSlugsByDevice.set(fw.device, new Set());
    firmwareSlugsByDevice.get(fw.device)!.add(fwSlug);
  }
}

for (const [device, shared] of sharedSlugsByDevice) {
  for (const [slug, file] of shared) {
    if (firmwareSlugsByDevice.get(device)?.has(slug)) {
      fail(file, `also_devices "${device}": src/content/firmwares/${device}/${slug}.yaml already exists; remove that copy or rename one of them`);
    }
  }
}

// Same source and same summary in two files: almost certainly one entry copied
// per device. Ports with their own summary (different build, requirements or
// install steps) are left alone.
for (const list of filesBySource.values()) {
  for (let i = 1; i < list.length; i++) {
    const twin = list.slice(0, i).find((o) => o.summary === list[i].summary);
    if (twin) warn(list[i].file, `same source and summary as ${rel(twin.file)}; make it one entry with also_devices`);
  }
}

for (const [slug, pinned] of devicePinned) {
  const file = join(DEVICES_DIR, `${slug}.yaml`);
  const seen = new Set<string>();
  for (const p of pinned) {
    if (seen.has(p)) fail(file, `pinned lists "${p}" more than once`);
    seen.add(p);
    if (!firmwareSlugsByDevice.get(slug)?.has(p) && !sharedSlugsByDevice.get(slug)?.has(p)) {
      fail(file, `pinned entry "${p}" has no file src/content/firmwares/${slug}/${p}.yaml and no entry lists ${slug} in also_devices`);
    }
  }
}

for (const slug of deviceSlugs) {
  if (!firmwareCountByDevice.has(slug) && !sharedSlugsByDevice.has(slug) && !deviceNotes.get(slug)) {
    warn(
      join(DEVICES_DIR, `${slug}.yaml`),
      'device has no firmware entries and no notes explaining why',
    );
  }
}

// ---- hotlinked media ------------------------------------------------------
//
// Videos are checked with YouTube's oEmbed endpoint (200 only for a public,
// embeddable video); images must answer 2xx with an image/* content type.
//
// How hard a broken link hits is set by the media-check mode, from `--media=<mode>`
// or ALTSTRUMENT_MEDIA_CHECK (the env var wins). An unknown value is an error:
// a typo must never loosen the run. Default is strict.
//   strict  definitive answers (404, 410, wrong type, and for videos 401/403) are
//           errors; timeouts, 5xx and DNS trouble are warnings. PR checks use this.
//   soft    every media problem is a warning, so broken links never fail the run.
//           For deploys: links rot without any commit.
//   off     no network pass. ALTSTRUMENT_SKIP_REMOTE=1 (any value) forces this
//           (offline development).
// An image host answering 401/403 is only a warning in every mode: many hosts
// refuse bots and CI addresses, so the checker can't tell a dead image from a
// blocked checker. Check those in a browser.
//
// Every media problem is recorded. With GITHUB_STEP_SUMMARY set, a "Hotlinked
// media" section (mode, then OK count or a table of problems) is appended to
// that file; with GITHUB_ACTIONS set, each problem is also printed as a
// ::error / ::warning annotation on its file. Paths and messages come from
// untrusted PRs, so annotation text is escaped.
//
// Links rot without any commit, so a pull request should not fail on media it
// didn't touch. CI sets ALTSTRUMENT_CHANGED_FILES to a file of NUL-separated
// repo-relative paths (`git diff -z --name-only`) and only those files' media
// are checked; pushes to main and the daily run check everything. The list is
// ignored outside a pull_request run, and an unreadable or empty list means
// everything is checked: a broken list must never loosen the run.

type MediaMode = 'strict' | 'soft' | 'off';
const MEDIA_MODES: readonly string[] = ['strict', 'soft', 'off'];

/** Mode from the env var, else `--media=`, else strict; ALTSTRUMENT_SKIP_REMOTE forces off. */
function mediaMode(): { mode: MediaMode; skipped: boolean } {
  const flag = process.argv.slice(2).find((a) => a.startsWith('--media='));
  const raw = process.env.ALTSTRUMENT_MEDIA_CHECK || (flag ? flag.slice('--media='.length) : 'strict');
  if (!MEDIA_MODES.includes(raw)) {
    const from = process.env.ALTSTRUMENT_MEDIA_CHECK ? 'ALTSTRUMENT_MEDIA_CHECK' : '--media';
    console.error(`${from}: unknown media check mode "${raw}" (use ${MEDIA_MODES.join(', ')})`);
    process.exit(1);
  }
  if (process.env.ALTSTRUMENT_SKIP_REMOTE) return { mode: 'off', skipped: true };
  return { mode: raw as MediaMode, skipped: false };
}

/** Escaping for GitHub workflow commands (`::error file=..::message`). */
function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** A hotlinked-media problem, as reported (file is repo-relative). */
type MediaProblem = { file: string; kind: 'video' | 'image'; url: string; message: string; level: 'error' | 'warning' };
const mediaProblems: MediaProblem[] = [];

function reportMedia(c: { file: string; kind: 'video' | 'image'; url: string }, message: string, level: 'error' | 'warning') {
  mediaProblems.push({ file: rel(c.file), kind: c.kind, url: c.url, message, level });
  (level === 'error' ? fail : warn)(c.file, message);
}

const VIDEO_DEFINITIVE = new Set([401, 403, 404, 410]);
const IMAGE_DEFINITIVE = new Set([404, 410]);

/** Repo-relative paths the PR changes, or undefined to check every file. */
function changedFiles(): Set<string> | undefined {
  const listFile = process.env.ALTSTRUMENT_CHANGED_FILES;
  if (!listFile) return undefined;
  const fallBack = (why: string) => {
    warnings.push(`ALTSTRUMENT_CHANGED_FILES: ${why}; checking all hotlinked media`);
    return undefined;
  };
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return fallBack('ignored outside a pull_request run');
  let paths: string[];
  try {
    paths = readFileSync(listFile, 'utf8').split('\0').filter(Boolean);
  } catch (e) {
    return fallBack(`could not read ${listFile} (${(e as Error).message})`);
  }
  if (!paths.length) return fallBack(`${listFile} lists no files`);
  return new Set(paths);
}
const REMOTE_CONCURRENCY = 8;

async function request(url: string, method: 'GET' | 'HEAD'): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        headers: { 'User-Agent': 'altstrument-validate' },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** undefined when fine, otherwise [definitive?, message]. */
async function checkRemote(kind: 'video' | 'image', url: string): Promise<[boolean, string] | undefined> {
  try {
    if (kind === 'video') {
      const res = await request(youtubeOembedUrl(url), 'GET');
      await res.body?.cancel();
      if (res.ok) return undefined;
      return [VIDEO_DEFINITIVE.has(res.status), `video ${url} is unavailable or not embeddable (oEmbed HTTP ${res.status})`];
    }
    let res = await request(url, 'HEAD');
    // Some hosts refuse HEAD; ask again with GET before calling it broken.
    if (!res.ok) res = await request(url, 'GET');
    const type = res.headers.get('content-type') ?? '';
    await res.body?.cancel();
    if (res.status === 401 || res.status === 403) {
      return [false, `image ${url}: host refused the checker (HTTP ${res.status}); check it in a browser`];
    }
    if (!res.ok) return [IMAGE_DEFINITIVE.has(res.status), `image ${url} returned HTTP ${res.status}`];
    if (!type.startsWith('image/')) return [true, `image ${url} is served as "${type || 'no content-type'}", not an image`];
    return undefined;
  } catch (e) {
    return [false, `${kind} ${url} could not be checked: ${(e as Error).message}`];
  }
}

const { mode: mediaCheckMode, skipped: mediaSkipped } = mediaMode();
let remoteNote = '';
let unchangedNote = '';
let mediaOkLine = '';
let mediaChecked = 0;
const changed = mediaCheckMode === 'off' ? undefined : changedFiles();
if (changed) {
  const total = remoteChecks.length;
  remoteChecks.splice(0, total, ...remoteChecks.filter((c) => changed.has(rel(c.file))));
  unchangedNote = ` (${total - remoteChecks.length} in unchanged files not checked)`;
}
if (mediaCheckMode === 'off') {
  const why = mediaSkipped ? 'ALTSTRUMENT_SKIP_REMOTE' : 'media check off';
  remoteNote = `, ${remoteChecks.length} hotlinked media not checked (${why})`;
  mediaOkLine = `${remoteChecks.length} hotlinked media not checked (${why}).`;
} else if (remoteChecks.length) {
  let next = 0;
  let broken = 0;
  mediaChecked = remoteChecks.length;
  // One request per URL, however many entries or `videos` lists share it.
  const pending = new Map<string, Promise<[boolean, string] | undefined>>();
  await Promise.all(
    Array.from({ length: Math.min(REMOTE_CONCURRENCY, remoteChecks.length) }, async () => {
      while (next < remoteChecks.length) {
        const c = remoteChecks[next++];
        const key = `${c.kind} ${c.url}`;
        if (!pending.has(key)) pending.set(key, checkRemote(c.kind, c.url));
        const problem = await pending.get(key);
        if (!problem) continue;
        broken++;
        reportMedia(c, problem[1], problem[0] && mediaCheckMode === 'strict' ? 'error' : 'warning');
      }
    }),
  );
  remoteNote =
    mediaCheckMode === 'soft' && broken
      ? `, ${remoteChecks.length - broken}/${remoteChecks.length} hotlinked media OK (${broken} broken, see warnings)${unchangedNote}`
      : `, ${remoteChecks.length - broken}/${remoteChecks.length} hotlinked media OK${unchangedNote}`;
  mediaOkLine = `All ${remoteChecks.length} hotlinked media OK.`;
} else if (changed) {
  remoteNote = `, no hotlinked media in changed files${unchangedNote}`;
  mediaOkLine = `No hotlinked media in changed files${unchangedNote}.`;
} else {
  mediaOkLine = 'No hotlinked media to check.';
}

/** Markdown table cell: no pipes, no line breaks, no raw HTML. */
function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n|\r/g, ' ').replace(/</g, '&lt;');
}
function mdCode(s: string): string {
  return `\`${s.replace(/`/g, '%60').replace(/\r?\n|\r/g, ' ').replace(/\|/g, '%7C')}\``;
}

/** Append the media results to the job summary; a failure to write only warns. */
function writeStepSummary() {
  const path = process.env.GITHUB_STEP_SUMMARY;
  // Off means another step reports media (CI's build step re-runs validate after the validate step).
  if (!path || mediaCheckMode === 'off') return;
  let md = `### Hotlinked media\n\nMode: \`${mediaCheckMode}\`${mediaSkipped ? ' (ALTSTRUMENT_SKIP_REMOTE)' : ''}\n\n`;
  if (mediaProblems.length) {
    md += `${mediaProblems.length} of ${mediaChecked} hotlinked media have problems.\n\n`;
    md += '| File | Kind | URL | Problem | Level |\n| --- | --- | --- | --- | --- |\n';
    for (const p of mediaProblems) {
      md += `| ${mdCode(p.file)} | ${p.kind} | ${mdCode(p.url)} | ${mdCell(p.message)} | ${p.level} |\n`;
    }
  } else {
    md += `${mediaOkLine}\n`;
  }
  try {
    appendFileSync(path, `${md}\n`);
  } catch (e) {
    warnings.push(`GITHUB_STEP_SUMMARY: could not write ${path} (${(e as Error).message})`);
  }
}

// ---- report ----------------------------------------------------------------

writeStepSummary();
if (process.env.GITHUB_ACTIONS) {
  for (const p of mediaProblems) {
    const cmd = p.level === 'error' ? 'error' : 'warning';
    console.log(`::${cmd} file=${escapeProperty(p.file)}::${escapeData(p.message)}`);
  }
}
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error(`  x ${e}`);
  console.error('\nCatalog validation failed.');
  process.exit(1);
}
console.log(
  `\nCatalog OK: ${deviceSlugs.size} device(s), ${firmwareTotal} firmware entr${firmwareTotal === 1 ? 'y' : 'ies'}${sharedTotal ? ` (${sharedTotal} listed on more than one device)` : ''}, ${manufacturerTotal} manufacturer file(s)${hiddenTotal ? ` (${hiddenTotal} hidden as stale)` : ''}${remoteNote}.`,
);
