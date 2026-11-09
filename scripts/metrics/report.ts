/**
 * Quality index report: threshold calibration and per-device rankings, from the
 * committed snapshot and the catalog YAML (no network).
 *
 *   pnpm metrics:report                       percentiles of every raw signal (to set THRESHOLDS)
 *   pnpm metrics:report --device m-vave-fm-1  top and bottom entries for a device (repeatable)
 *   pnpm metrics:report --device x --top 25   longer lists
 *   pnpm metrics:report --entry m-vave-fm-1/dirge   one entry's pillars and facts
 *   pnpm metrics:report --diff origin/main    entries whose public rating differs from the
 *                                             snapshot locked at that git ref (Markdown)
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'astro/zod';
import { deviceSchema, firmwareBaseSchema, refineFirmware } from '../../src/content/schema';
import { computeQuality, PILLARS, THRESHOLDS, type QualityDevice, type QualityInput, type QualityFacts } from '../../src/lib/quality';
import { LOCK_FILE, loadMetrics, loadSnapshotForLock, parseLock } from '../../src/lib/repo-metrics';

const ROOT = new URL('../..', import.meta.url).pathname;
const FIRMWARES_DIR = join(ROOT, 'src/content/firmwares');
const DEVICES_DIR = join(ROOT, 'src/content/devices');
const schema = refineFirmware(firmwareBaseSchema.extend({ device: z.string() }));

const args = process.argv.slice(2);
const devices: string[] = [];
const entries: string[] = [];
let top = 10;
let diffRef: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--device') devices.push(args[++i]);
  else if (args[i] === '--entry') entries.push(args[++i]);
  else if (args[i] === '--top') top = Number(args[++i]);
  else if (args[i] === '--diff') diffRef = args[++i];
  else throw new Error(`unknown argument ${args[i]}`);
}

const inputs: (QualityInput & { name: string })[] = [];
for (const dir of readdirSync(FIRMWARES_DIR)) {
  for (const file of readdirSync(join(FIRMWARES_DIR, dir))) {
    if (!file.endsWith('.yaml')) continue;
    const parsed = schema.safeParse(parse(readFileSync(join(FIRMWARES_DIR, dir, file), 'utf8')));
    if (!parsed.success) continue; // validate.ts reports these
    const fw = parsed.data;
    inputs.push({
      ...fw,
      name: fw.name,
      id: `${dir}/${file.replace(/\.yaml$/, '')}`,
      deviceIds: [dir, ...fw.also_devices],
    });
  }
}

const devicesById: Record<string, QualityDevice> = {};
for (const file of readdirSync(DEVICES_DIR)) {
  if (!file.endsWith('.yaml')) continue;
  const parsed = deviceSchema.safeParse(parse(readFileSync(join(DEVICES_DIR, file), 'utf8')));
  if (!parsed.success) continue;
  const d = parsed.data;
  devicesById[file.replace(/\.yaml$/, '')] = { manufacturer: d.manufacturer, community: d.links.community, quality: d.quality };
}

const snapshot = await loadMetrics(ROOT);
if (!snapshot) console.warn(`No ${LOCK_FILE}; every entry is limited data.`);
const quality = computeQuality(inputs, snapshot, devicesById).entries;
const nameOf = new Map(inputs.map((i) => [i.id, i.name]));

if (diffRef) {
  // Public ratings now versus with the snapshot locked at diffRef (same catalog).
  let baseLockText: string | undefined;
  try {
    baseLockText = execFileSync('git', ['show', `${diffRef}:${LOCK_FILE}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    /* no lock at that ref */
  }
  const base = baseLockText ? (await loadSnapshotForLock(parseLock(baseLockText), ROOT, { skipRemote: false }))?.snapshot ?? null : null;
  const before = computeQuality(inputs, base, devicesById).entries;
  const label = (r: string | undefined) => (r ? r[0].toUpperCase() + r.slice(1) : 'unrated');
  const pub = (q: { rating?: string; hidden: boolean } | undefined) => (q && !q.hidden ? q.rating : undefined);
  const changes = inputs
    .map((i) => ({ id: i.id, name: i.name, from: pub(before.get(i.id)), to: pub(quality.get(i.id)) }))
    .filter((c) => c.from !== c.to)
    .sort((a, b) => a.id.localeCompare(b.id));
  const site = 'https://altstrument.org';
  console.log(`Snapshot ${base?.fetchedAt.slice(0, 10) ?? 'none'} (${diffRef}) → ${snapshot?.fetchedAt.slice(0, 10) ?? 'none'}.`);
  console.log(`\n${changes.length} ${changes.length === 1 ? 'entry changes' : 'entries change'} public rating.\n`);
  if (changes.length) {
    console.log('| Entry | Before | After |\n| --- | --- | --- |');
    for (const c of changes) console.log(`| [${c.name.replace(/\|/g, '\\|')}](${site}/firmware/${c.id}) | ${label(c.from)} | ${label(c.to)} |`);
  }
  process.exit(0);
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
};
const fmt = (x: number | null | undefined) => (x === null || x === undefined ? '  –' : x.toFixed(2).padStart(4));

if (!devices.length && !entries.length) {
  const withData = [...quality.values()].filter((q) => !q.limited);
  console.log(`${quality.size} entries, ${withData.length} with GitHub data, snapshot ${snapshot?.fetchedAt ?? 'none'}\n`);
  console.log('signal             p50     p75     p90     p95     p99   threshold');
  const facts: [keyof QualityFacts, keyof typeof THRESHOLDS | undefined][] = [
    ['ageYears', 'ageYears'],
    ['releases', 'releases'],
    ['commits', 'commits'],
    ['commitsLastYear', 'commitsLastYear'],
    ['stars', 'stars'],
    ['forks', 'forks'],
    ['watchers', 'watchers'],
    ['activeForks', undefined],
    ['contributors', 'contributors'],
    ['busFactor', 'busFactor'],
    ['discussions', 'discussions'],
  ];
  for (const [f, t] of facts) {
    const xs = withData.map((q) => q.facts[f]).filter((v): v is number => typeof v === 'number');
    const row = [50, 75, 90, 95, 99].map((p) => pct(xs, p).toFixed(1).padStart(7)).join(' ');
    console.log(`${f.padEnd(16)} ${row}   ${t ? THRESHOLDS[t] : ''}`);
  }
  console.log('\npillar           p50   p90   mean');
  for (const p of PILLARS) {
    const xs = [...quality.values()].map((q) => q.pillars[p]).filter((v): v is number => v !== null);
    console.log(`${p.padEnd(14)} ${fmt(pct(xs, 50))}  ${fmt(pct(xs, 90))}  ${fmt(xs.reduce((a, b) => a + b, 0) / xs.length)}`);
  }
  const scores = [...quality.values()].map((q) => q.score);
  console.log(`\nscore p10 ${pct(scores, 10)}  p50 ${pct(scores, 50)}  p90 ${pct(scores, 90)}  p99 ${pct(scores, 99)}`);
  const ratings: Record<string, number> = {};
  for (const q of quality.values()) ratings[q.rating ?? 'unrated'] = (ratings[q.rating ?? 'unrated'] ?? 0) + 1;
  console.log('ratings', ratings);
  // How many entries with GitHub data clear each candidate bar (for setting MIN_RATED_SCORE).
  const withRepo = [...quality.values()].filter((q) => !q.limited);
  console.log(
    'rated at bar',
    Object.fromEntries([40, 45, 48, 50, 52, 55].map((b) => [b, withRepo.filter((q) => q.score >= b).length])),
    `of ${withRepo.length}`,
  );
  const finished = [...quality.entries()].filter(([, q]) => q.facts.finished);
  console.log(`finished-project rule applied to ${finished.length} entries`);
}

const header = `score  ${PILLARS.map((p) => p.slice(0, 4).padStart(4)).join(' ')}  entry`;
const line = (id: string) => {
  const q = quality.get(id)!;
  const flags = [q.rating ?? 'unrated', q.hidden && 'hidden', q.override && `override ${q.override.level}`, q.shared && 'shared', q.firstParty && 'first-party', q.limited && 'limited', q.facts.finished && 'finished', q.facts.archived && 'archived', q.facts.parentId && `← ${q.facts.parentId}`, q.facts.childIds.length && `${q.facts.childIds.length} children`]
    .filter(Boolean)
    .join(', ');
  return `${String(q.score).padStart(5)}  ${PILLARS.map((p) => fmt(q.pillars[p])).join(' ')}  ${nameOf.get(id)} (${id})${flags ? `  [${flags}]` : ''}`;
};

for (const d of devices) {
  const ids = inputs.filter((i) => i.deviceIds.includes(d)).map((i) => i.id);
  ids.sort((a, b) => quality.get(b)!.score - quality.get(a)!.score);
  console.log(`\n== ${d}: ${ids.length} entries ==\n${header}`);
  for (const id of ids.slice(0, top)) console.log(line(id));
  if (ids.length > top * 2) console.log('  …');
  for (const id of ids.slice(Math.max(top, ids.length - top))) console.log(line(id));
}

for (const id of entries) {
  const q = quality.get(id);
  if (!q) {
    console.log(`\n${id}: not found`);
    continue;
  }
  console.log(`\n${header}\n${line(id)}\n${JSON.stringify({ rank: q.rank, facts: q.facts }, null, 2)}`);
}
