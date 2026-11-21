/**
 * Deterministic scan for the /garden skill (.claude/skills/garden/).
 *
 * Looks for catalog hygiene problems: firmware entries with the wrong `kind`,
 * duplicate entries and missing `related` crosslinks. It NEVER edits catalog
 * files; it only reports. The /garden skill runs this script, then reviews the
 * slice of devices it names with the maintainer.
 *
 *   npx tsx .claude/skills/garden/scan.ts [flags]
 *
 *   --slice a,b,c      replace the slice with these device slugs
 *   --device <slug>    slice is that one device
 *   --slice-size N     override slice_size from config.yaml
 *   --changed          slice is the devices whose catalog files differ from
 *                      --base (default HEAD: uncommitted work, untracked files
 *                      included), and only findings that touch one of those
 *                      files are kept. Used by /discover after a run. Never
 *                      moves the cursor.
 *   --base <ref>       git ref --changed compares against (e.g. origin/main)
 *   --no-based-on      skip the based-on proposer
 *   --no-gh            pass --no-gh to the proposer (no GitHub fork lookups)
 *   --check a[,b]      limit the markdown report to these checks
 *   --json-only        no markdown on stdout
 *
 * Writes garden-findings.json at the repo root and prints a markdown report.
 * Exit code 0 on success; 2 on bad usage.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';

const ROOT = new URL('../../../', import.meta.url).pathname;
const CONFIG_PATH = new URL('./config.yaml', import.meta.url).pathname;
const OUT_PATH = join(ROOT, 'garden-findings.json');
const DEVICES_DIR = join(ROOT, 'src/content/devices');
const FW_DIR = join(ROOT, 'src/content/firmwares');

const SECTION_CAP = 60;
const CANDIDATE_CAP = 40;

// ---- types -----------------------------------------------------------------

const CHECKS = [
  'kind-suspect',
  'kind-pseudo-device',
  'duplicate-source',
  'duplicate-homepage',
  'duplicate-name',
  'duplicate-device',
  'related-asymmetric',
  'related-from-also-devices',
  'related-from-based-on',
  'related-same-platform',
  'related-variant',
  'based-on-proposal',
  'also-devices-candidate',
] as const;
type Check = (typeof CHECKS)[number];

interface Finding {
  check: Check;
  key: string;
  files: string[];
  detail: string;
  confidence: 'clear' | 'suspect';
  suggestion?: string;
  inSlice: boolean;
}

interface Config {
  slice_size: number;
  cursor: string | null;
  pseudo_devices: string[];
  tool_signals: { tags: string[]; phrases: string[] };
  firmware_signals: { phrases: string[] };
  accepted: { check: string; key: string; reason?: string; date?: string }[];
}

interface Device {
  slug: string;
  file: string;
  name: string;
  manufacturer: string;
  platform: string;
  related: string[];
}

interface Fw {
  device: string;
  slug: string;
  ref: string;
  file: string;
  name: string;
  kind: 'firmware' | 'tool';
  summary: string;
  description: string;
  installNotes: string;
  tags: string[];
  source?: string;
  homepage?: string;
  basedOn?: string;
  alsoDevices: string[];
}

// ---- loading ---------------------------------------------------------------

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asStrArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function loadYaml(path: string): Record<string, unknown> {
  const doc = parse(readFileSync(path, 'utf8'));
  return doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
}

function loadConfig(): Config {
  const c = loadYaml(CONFIG_PATH);
  return {
    slice_size: typeof c.slice_size === 'number' ? c.slice_size : 45,
    cursor: typeof c.cursor === 'string' ? c.cursor : null,
    pseudo_devices: asStrArr(c.pseudo_devices),
    tool_signals: {
      tags: asStrArr((c.tool_signals as Record<string, unknown> | undefined)?.tags),
      phrases: asStrArr((c.tool_signals as Record<string, unknown> | undefined)?.phrases),
    },
    firmware_signals: { phrases: asStrArr((c.firmware_signals as Record<string, unknown> | undefined)?.phrases) },
    accepted: Array.isArray(c.accepted)
      ? (c.accepted as Record<string, unknown>[]).map((a) => ({ check: asStr(a.check), key: asStr(a.key) }))
      : [],
  };
}

function loadDevices(): Device[] {
  return readdirSync(DEVICES_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => {
      const d = loadYaml(join(DEVICES_DIR, f));
      return {
        slug: f.replace(/\.yaml$/, ''),
        file: `src/content/devices/${f}`,
        name: asStr(d.name),
        manufacturer: asStr(d.manufacturer),
        platform: asStr(d.platform),
        related: asStrArr(d.related),
      };
    });
}

function loadFirmwares(): { fws: Fw[]; dirs: string[] } {
  const dirs = readdirSync(FW_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const fws: Fw[] = [];
  for (const dir of dirs) {
    for (const f of readdirSync(join(FW_DIR, dir)).filter((x) => x.endsWith('.yaml')).sort()) {
      const d = loadYaml(join(FW_DIR, dir, f));
      if (d.generated_from) continue;
      const slug = f.replace(/\.yaml$/, '');
      fws.push({
        device: dir,
        slug,
        ref: `${dir}/${slug}`,
        file: `src/content/firmwares/${dir}/${f}`,
        name: asStr(d.name),
        kind: d.kind === 'tool' ? 'tool' : 'firmware',
        summary: asStr(d.summary),
        description: asStr(d.description),
        installNotes: asStr(d.install_notes),
        tags: asStrArr(d.tags),
        source: asStr(d.source) || undefined,
        homepage: asStr(d.homepage) || undefined,
        basedOn: asStr(d.based_on) || undefined,
        alsoDevices: asStrArr(d.also_devices),
      });
    }
  }
  return { fws, dirs };
}

// ---- helpers ---------------------------------------------------------------

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const pairKey = (a: string, b: string) => [a, b].sort().join(' + ');

function normUrl(u: string, cutTree: boolean): string {
  let s = u.trim().toLowerCase();
  // Drop a bare branch (`/tree/main`) but keep subdirectory paths: monorepo
  // subprojects under one repo are distinct entries, not duplicates.
  if (cutTree) s = s.replace(/\/(tree|blob)\/[^/]+\/?$/, '');
  s = s.replace(/[?#].*$/, '');
  s = s.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return s;
}

function groupBy<T>(items: T[], key: (t: T) => string | undefined): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!k) continue;
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/** Catalog files (src/content/**) that differ from `base`, plus untracked ones. */
function changedCatalogFiles(base: string): Set<string> {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  let files: string[];
  try {
    files = [
      ...git(['diff', '--name-only', base, '--', 'src/content']),
      ...git(['ls-files', '--others', '--exclude-standard', '--', 'src/content']),
    ];
  } catch (e) {
    console.error(`--changed: git failed for base ${base}: ${(e as Error).message}`);
    process.exit(2);
  }
  return new Set(files);
}

// ---- main ------------------------------------------------------------------

function main() {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      options: {
        slice: { type: 'string' },
        device: { type: 'string' },
        'slice-size': { type: 'string' },
        changed: { type: 'boolean', default: false },
        base: { type: 'string' },
        'no-based-on': { type: 'boolean', default: false },
        'no-gh': { type: 'boolean', default: false },
        check: { type: 'string' },
        'json-only': { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    console.error(`usage error: ${(e as Error).message}`);
    process.exit(2);
  }
  const reportChecks = values.check
    ? new Set((values.check as string).split(',').map((s) => s.trim()))
    : null;
  if (reportChecks) {
    for (const c of reportChecks) {
      if (!(CHECKS as readonly string[]).includes(c)) {
        console.error(`unknown check: ${c}`);
        process.exit(2);
      }
    }
  }

  const config = loadConfig();
  const devices = loadDevices();
  const { fws, dirs } = loadFirmwares();
  const deviceBySlug = new Map(devices.map((d) => [d.slug, d]));
  const pseudo = new Set(config.pseudo_devices);

  // ---- slice
  let slice: string[];
  let nextCursor: string;
  let wrapped = false;
  let changedFiles: Set<string> | null = null;
  if (values.changed) {
    changedFiles = changedCatalogFiles((values.base as string | undefined) ?? 'HEAD');
    const touched = new Set<string>();
    for (const f of changedFiles) {
      const m = /^src\/content\/(?:firmwares\/([^/]+)\/|devices\/([^/]+)\.yaml$)/.exec(f);
      const slug = m?.[1] ?? m?.[2];
      if (slug) touched.add(slug);
    }
    slice = [...touched].sort();
    nextCursor = config.cursor ?? '';
  } else if (values.device) {
    slice = [values.device as string];
    nextCursor = slice[0];
  } else if (values.slice) {
    slice = (values.slice as string).split(',').map((s) => s.trim()).filter(Boolean);
    nextCursor = slice[slice.length - 1] ?? '';
  } else {
    const size = values['slice-size'] ? Number(values['slice-size']) : config.slice_size;
    if (!Number.isInteger(size) || size < 1) {
      console.error('--slice-size must be a positive integer');
      process.exit(2);
    }
    const idx = config.cursor ? dirs.indexOf(config.cursor) : -1;
    const start = idx + 1;
    const n = Math.min(size, dirs.length);
    slice = [];
    for (let i = 0; i < n; i++) {
      const j = start + i;
      if (j >= dirs.length) wrapped = true;
      slice.push(dirs[j % dirs.length]);
    }
    nextCursor = slice[slice.length - 1] ?? '';
  }
  const sliceSet = new Set(slice);
  const sliceFwCount = fws.filter((f) => sliceSet.has(f.device)).length;

  // file -> device slug, for inSlice
  const fileDevice = new Map<string, string>();
  for (const d of devices) fileDevice.set(d.file, d.slug);
  for (const f of fws) fileDevice.set(f.file, f.device);
  const inSlice = (files: string[]) => files.some((f) => sliceSet.has(fileDevice.get(f) ?? ''));

  const findings: Finding[] = [];
  // A pair that already says one derives from the other (based_on) is a known
  // fork, not a duplicate.
  const refByFile = new Map(fws.map((f) => [f.file, f]));
  const linkedByBasedOn = (files: string[]) => {
    if (files.length !== 2) return false;
    const [x, y] = files.map((p) => refByFile.get(p));
    return !!x && !!y && (x.basedOn === y.ref || y.basedOn === x.ref);
  };
  const add = (f: Omit<Finding, 'inSlice'>) => {
    if (f.check.startsWith('duplicate-') && f.check !== 'duplicate-device' && linkedByBasedOn(f.files)) return;
    findings.push({ ...f, inSlice: inSlice(f.files) });
  };

  // ---- related graph
  const relatedLink = (a: string, b: string) =>
    (deviceBySlug.get(a)?.related.includes(b) ?? false) || (deviceBySlug.get(b)?.related.includes(a) ?? false);
  const isPseudo = (s: string) => pseudo.has(s);
  const devFile = (s: string) => deviceBySlug.get(s)?.file ?? `src/content/devices/${s}.yaml`;

  // ---- 1 kind-suspect, 2 kind-pseudo-device
  const toolTags = new Set(config.tool_signals.tags.map((t) => t.toLowerCase()));
  const toolPhrases = config.tool_signals.phrases.map((p) => p.toLowerCase());
  const fwPhrases = config.firmware_signals.phrases.map((p) => p.toLowerCase());
  for (const f of fws) {
    const text = `${f.name} ${f.summary} ${f.description}`.toLowerCase();
    const matchedTags = f.tags.filter((t) => toolTags.has(t.toLowerCase()));
    const matchedTool = toolPhrases.filter((p) => text.includes(p));
    const matchedFw = fwPhrases.filter((p) => text.includes(p));
    if (f.kind === 'firmware') {
      if ((matchedTags.length || matchedTool.length) && !matchedFw.length) {
        const sig = [...matchedTags.map((t) => `tag ${t}`), ...matchedTool.map((p) => `"${p}"`)];
        add({
          check: 'kind-suspect',
          key: f.ref,
          files: [f.file],
          detail: `kind firmware but looks like a tool: ${sig.join(', ')}; no firmware phrase`,
          confidence: 'suspect',
        });
      }
      if (isPseudo(f.device) && f.device.endsWith('-tools')) {
        add({
          check: 'kind-pseudo-device',
          key: f.ref,
          files: [f.file],
          detail: `kind firmware on tools-only device ${f.device}`,
          confidence: 'clear',
          suggestion: `set kind: tool in ${f.file}`,
        });
      }
    } else if (!matchedTags.length && !matchedTool.length && matchedFw.length) {
      add({
        check: 'kind-suspect',
        key: f.ref,
        files: [f.file],
        detail: `kind tool but looks like firmware: ${matchedFw.map((p) => `"${p}"`).join(', ')}; no tool tag or phrase`,
        confidence: 'suspect',
      });
    }
  }

  // ---- name stripping helpers for duplicate checks
  const nameSet = new Set<string>();
  for (const d of devices) {
    if (d.name) nameSet.add(d.name.toLowerCase());
    if (d.manufacturer && d.name) nameSet.add(`${d.manufacturer} ${d.name}`.toLowerCase());
  }
  const namesLongFirst = [...nameSet].filter((n) => n.length >= 2).sort((a, b) => b.length - a.length);
  const nameRes = namesLongFirst.map((n) => new RegExp(`(?<![a-z0-9])${esc(n)}(?![a-z0-9])`, 'g'));
  const stripDeviceNames = (s: string) => {
    let out = s.toLowerCase();
    for (const re of nameRes) out = out.replace(re, ' ');
    return collapse(out);
  };
  const deviceWords = new Set<string>();
  for (const n of nameSet) for (const w of n.split(/[^a-z0-9]+/)) if (w.length >= 3) deviceWords.add(w);

  // ---- 3 duplicate-source
  const bySource = groupBy(fws, (f) => (f.source ? normUrl(f.source, true) : undefined));
  const reportedSourceGroups = new Set<string>();
  for (const [key, group] of bySource) {
    if (group.length < 2) continue;
    const files = group.map((g) => g.file);
    reportedSourceGroups.add([...files].sort().join('|'));
    const sums = new Set(group.map((g) => stripDeviceNames(g.summary)));
    const merge = sums.size === 1;
    const devs = new Set(group.map((g) => g.device));
    const where = devs.size > 1 ? `different devices (${[...devs].join(', ')})` : `same device (${[...devs][0]})`;
    add({
      check: 'duplicate-source',
      key,
      files,
      detail: `${merge ? 'merge-candidate' : 'separate-port?'}: ${group.length} entries share this source on ${where}: ${group.map((g) => g.ref).join(', ')}`,
      confidence: merge ? 'clear' : 'suspect',
      suggestion: merge ? `merge ${group.map((g) => g.ref).join(' and ')} into one entry using also_devices` : undefined,
    });
  }

  // ---- 4 duplicate-homepage
  const byHome = groupBy(fws, (f) => (f.homepage ? normUrl(f.homepage, false) : undefined));
  for (const [key, group] of byHome) {
    if (group.length < 2) continue;
    const files = group.map((g) => g.file);
    if (reportedSourceGroups.has([...files].sort().join('|'))) continue;
    const devs = new Set(group.map((g) => g.device));
    add({
      check: 'duplicate-homepage',
      key,
      files,
      detail: `${group.length} entries share this homepage on ${devs.size > 1 ? 'different devices' : 'the same device'}: ${group.map((g) => g.ref).join(', ')}`,
      confidence: 'suspect',
    });
  }

  // ---- 5 duplicate-name
  const normName = (n: string) => {
    let s = n.toLowerCase().replace(/\([^)]*\)/g, ' ');
    const m = / for (.+)$/.exec(s);
    if (m && m[1].split(/[^a-z0-9]+/).some((w) => deviceWords.has(w))) s = s.slice(0, m.index);
    s = stripDeviceNames(s);
    return collapse(s.replace(/[^a-z0-9\s]/g, ' '));
  };
  const byName = groupBy(fws, (f) => normName(f.name) || undefined);
  for (const [key, group] of byName) {
    if (group.length < 2) continue;
    const files = group.map((g) => g.file);
    if (reportedSourceGroups.has([...files].sort().join('|'))) continue;
    // fully covered: every pair already shares a source group
    const srcs = new Set(group.map((g) => (g.source ? normUrl(g.source, true) : '')));
    if (srcs.size === 1 && [...srcs][0] !== '') continue;
    const devs = new Set(group.map((g) => g.device));
    // Across makers a shared name is almost always a coincidence (Mark, Belt,
    // Toolkit). Keep groups on one device, on one maker's devices, or with one
    // GitHub owner.
    const makers = new Set(group.map((g) => deviceBySlug.get(g.device)?.manufacturer.toLowerCase().trim()));
    const owners = new Set(group.map((g) => /github\.com\/([^/]+)/i.exec(g.source ?? '')?.[1]?.toLowerCase() ?? `none:${g.ref}`));
    if (devs.size > 1 && makers.size > 1 && owners.size > 1) continue;
    add({
      check: 'duplicate-name',
      key,
      files,
      detail: `${group.length} entries named alike on ${devs.size > 1 ? 'different devices' : 'the same device'}: ${group.map((g) => `${g.ref} ("${g.name}")`).join(', ')}`,
      confidence: 'suspect',
    });
  }

  // ---- 6 duplicate-device
  const normDev = (n: string) =>
    collapse(
      n
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => !['mk2', 'mkii', 'pro', 'plus'].includes(w))
        .join(' '),
    );
  const byMaker = groupBy(devices, (d) => d.manufacturer.toLowerCase().trim() || undefined);
  for (const group of byMaker.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (isPseudo(a.slug) || isPseudo(b.slug)) continue;
        const na = normDev(a.name);
        const nb = normDev(b.name);
        if (na.length < 3 || nb.length < 3) continue;
        const wordIn = (x: string, y: string) => new RegExp(`(^| )${esc(x)}( |$)`).test(y);
        const raw = (n: string) => collapse(n.toLowerCase().replace(/\+/g, ' plus ').replace(/[^a-z0-9]+/g, ' '));
        if (raw(a.name) === raw(b.name)) {
          add({
            check: 'duplicate-device',
            key: [a.slug, b.slug].sort().join(' + '),
            files: [a.file, b.file],
            detail: `same manufacturer ${a.manufacturer}: "${a.name}" and "${b.name}"`,
            confidence: 'suspect',
          });
        } else if ((na === nb || wordIn(na, nb) || wordIn(nb, na)) && !relatedLink(a.slug, b.slug)) {
          // Model variants (mkII, XL, Pro) are separate products, not duplicates,
          // but they usually share firmware and should link each other.
          add({
            check: 'related-variant',
            key: pairKey(a.slug, b.slug),
            files: [a.file, b.file],
            detail: `${a.manufacturer} "${a.name}" and "${b.name}" look like variants of one model but are not related`,
            confidence: 'suspect',
            suggestion: `add ${b.slug} to related in ${a.file} and ${a.slug} to related in ${b.file}`,
          });
        }
      }
    }
  }

  // ---- 7 related-asymmetric
  // Clear only with evidence of shared firmware or hardware: one maker, or a
  // firmware entry that spans both devices. Otherwise the forward link may be a
  // "similar product" link that should be removed, not mirrored.
  const sharedFirmware = new Set<string>();
  for (const f of fws) {
    if (f.kind !== 'firmware') continue;
    const all = [...new Set([f.device, ...f.alsoDevices])];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) sharedFirmware.add(pairKey(all[i], all[j]));
    if (f.basedOn && /^[a-z0-9-]+\/[a-z0-9-]+$/.test(f.basedOn)) sharedFirmware.add(pairKey(f.device, f.basedOn.split('/')[0]));
  }
  for (const a of devices) {
    for (const bSlug of a.related) {
      const b = deviceBySlug.get(bSlug);
      if (!b || isPseudo(a.slug) || isPseudo(b.slug)) continue;
      if (b.related.includes(a.slug)) continue;
      const evidence =
        a.manufacturer.toLowerCase().trim() === b.manufacturer.toLowerCase().trim() || sharedFirmware.has(pairKey(a.slug, b.slug));
      add({
        check: 'related-asymmetric',
        key: `${a.slug} -> ${b.slug}`,
        files: [a.file, b.file],
        detail: `${a.slug} lists ${b.slug} in related, but ${b.slug} does not list ${a.slug}${evidence ? '' : ' (different makers, no shared firmware: check before mirroring)'}`,
        confidence: evidence ? 'clear' : 'suspect',
        suggestion: `add ${a.slug} to related in ${b.file}`,
      });
    }
  }

  // ---- 8 related-from-also-devices
  const alsoPairs = new Map<string, Set<string>>();
  const pairDevs = new Map<string, [string, string]>();
  /** Pairs backed by at least one firmware-kind entry. */
  const firmwarePairs = new Set<string>();
  for (const f of fws) {
    const all = [...new Set([f.device, ...f.alsoDevices])].filter((s) => deviceBySlug.has(s) && !isPseudo(s));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (relatedLink(all[i], all[j])) continue;
        const k = pairKey(all[i], all[j]);
        pairDevs.set(k, [all[i], all[j]].sort() as [string, string]);
        if (!alsoPairs.has(k)) alsoPairs.set(k, new Set());
        alsoPairs.get(k)!.add(f.file);
        if (f.kind === 'firmware') firmwarePairs.add(k);
      }
    }
  }
  for (const [k, files] of alsoPairs) {
    const [x, y] = pairDevs.get(k)!;
    // Clear only when one firmware build runs on two devices of one maker, which
    // means shared hardware. Host tools that cover several brands (a multi-synth
    // editor) say nothing about the hardware, so those pairs are only suspects.
    const sameMaker =
      deviceBySlug.get(x)!.manufacturer.toLowerCase().trim() === deviceBySlug.get(y)!.manufacturer.toLowerCase().trim();
    const clear = sameMaker && firmwarePairs.has(k);
    add({
      check: 'related-from-also-devices',
      key: k,
      files: [devFile(x), devFile(y), ...files],
      detail: `${x} and ${y} are served by the same ${clear ? 'firmware' : sameMaker ? 'tool' : 'cross-brand entry'}${files.size > 1 ? ' (several entries)' : ''} but not related`,
      confidence: clear ? 'clear' : 'suspect',
      suggestion: `add ${y} to related in ${devFile(x)} and ${x} to related in ${devFile(y)}`,
    });
  }

  // ---- 9 related-from-based-on
  const basedPairs = new Map<string, { x: string; y: string; files: Set<string> }>();
  for (const f of fws) {
    if (!f.basedOn || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(f.basedOn)) continue;
    const other = f.basedOn.split('/')[0];
    if (other === f.device || !deviceBySlug.has(other) || isPseudo(other) || isPseudo(f.device)) continue;
    if (relatedLink(f.device, other)) continue;
    const k = pairKey(f.device, other);
    if (!basedPairs.has(k)) basedPairs.set(k, { x: f.device, y: other, files: new Set() });
    basedPairs.get(k)!.files.add(f.file);
  }
  for (const [k, { x, y, files }] of basedPairs) {
    add({
      check: 'related-from-based-on',
      key: k,
      files: [devFile(x), devFile(y), ...files],
      detail: `${[...files].length} entr${files.size > 1 ? 'ies' : 'y'} on ${x} based_on an entry on ${y}, devices not related`,
      confidence: 'suspect',
    });
  }

  // ---- 10 related-same-platform
  const byPlat = groupBy(
    devices.filter((d) => d.platform.trim() && d.manufacturer.trim() && !isPseudo(d.slug)),
    (d) => `${d.manufacturer.toLowerCase().trim()}|${d.platform.toLowerCase().trim()}`,
  );
  for (const group of byPlat.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (relatedLink(a.slug, b.slug)) continue;
        add({
          check: 'related-same-platform',
          key: pairKey(a.slug, b.slug),
          files: [a.file, b.file],
          detail: `${a.manufacturer} ${a.slug} and ${b.slug} share platform "${a.platform}"`,
          confidence: 'suspect',
        });
      }
    }
  }

  // ---- 11 based-on-proposal
  let proposerNote = '';
  if (!values['no-based-on']) {
    const tmp = mkdtempSync(join(tmpdir(), 'garden-based-on-'));
    try {
      const args = ['tsx', 'scripts/metrics/propose-based-on.ts', '--out', tmp];
      if (values['no-gh']) args.push('--no-gh');
      execFileSync('npx', args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
      const jp = join(tmp, 'based-on-proposals.json');
      if (existsSync(jp)) {
        const rows = JSON.parse(readFileSync(jp, 'utf8')) as {
          file: string;
          class: string;
          phrase?: string;
          proposed?: string;
          candidates?: string[];
        }[];
        for (const r of rows) {
          if (r.class !== 'confident' && r.class !== 'ambiguous') continue;
          const ref = r.file.replace(/\.yaml$/, '');
          const file = `src/content/firmwares/${r.file}`;
          if (r.class === 'confident') {
            add({
              check: 'based-on-proposal',
              key: ref,
              files: [file],
              detail: `prose says "${r.phrase ?? ''}", proposed based_on ${r.proposed}`,
              confidence: 'clear',
              suggestion: `add based_on: ${r.proposed} to ${file}`,
            });
          } else {
            add({
              check: 'based-on-proposal',
              key: ref,
              files: [file],
              detail: `prose says "${r.phrase ?? ''}", candidates: ${(r.candidates ?? []).join(', ')}`,
              confidence: 'suspect',
            });
          }
        }
      }
    } catch (e) {
      proposerNote = `based-on proposer failed: ${(e as Error).message.split('\n')[0]}`;
      console.error(proposerNote);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ---- 12 also-devices-candidate
  const GENERIC = new Set([
    'pro', 'mini', 'micro', 'one', 'synth', 'sampler', 'drum', 'machine', 'drums', 'keys', 'pad', 'pads', 'box',
    'studio', 'live', 'play', 'player', 'groove', 'beat', 'beats', 'mk1', 'mk2', 'mkii', 'plus', 'max', 'air', 'go',
    'core', 'device', 'module', 'controller', 'mixer', 'delay', 'reverb', 'looper', 'pedal', 'sequencer', 'the',
    'and', 'for', 'new', 'classic', 'digital', 'analog', 'FX', 'fx', 'workstation', 'handheld', 'console', 'preset', 'clock', 'tracker', 'grid', 'move', 'seed', 'step', 'edit',
  ]);
  const candDevices = devices.filter((d) => {
    const n = d.name.trim();
    if (n.length < 4 || isPseudo(d.slug)) return false;
    const words = n.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return !words.every((w) => GENERIC.has(w) || /^\d+$/.test(w));
  });
  const candRes = candDevices.map((d) => ({
    d,
    re: new RegExp(`(?<![a-z0-9])${esc(d.name.trim().toLowerCase())}(?![a-z0-9])`),
  }));
  const slugsByDevice = new Map<string, Set<string>>();
  const sourcesByDevice = new Map<string, Set<string>>();
  for (const f of fws) {
    if (!slugsByDevice.has(f.device)) slugsByDevice.set(f.device, new Set());
    slugsByDevice.get(f.device)!.add(f.slug);
    if (!sourcesByDevice.has(f.device)) sourcesByDevice.set(f.device, new Set());
    if (f.source) sourcesByDevice.get(f.device)!.add(normUrl(f.source, true));
  }
  // Flag only a sentence that names the device with a compatibility cue and
  // without a derivation cue: "also runs on the MiniFreak" counts, "port of the
  // Plaits engine" or "emulates the Machinedrum" does not.
  const COMPAT = /\b(also|both|as well as|works with|runs on|compatible with|supports?|and on)\b/;
  const DERIVED = /\b(port(ed)? of|ports?\b|emulat\w*|based on|inspired|engine|clone|recreat\w*|modell?ed|after the)\b/;
  for (const f of fws) {
    if (isPseudo(f.device)) continue;
    const sentences = `${f.summary}. ${f.installNotes}`
      .toLowerCase()
      .split(/(?<=[.;:!?])\s+/)
      .filter((x) => COMPAT.test(x) && !DERIVED.test(x));
    if (!sentences.length) continue;
    const text = sentences.join(' ');
    const src = f.source ? normUrl(f.source, true) : undefined;
    for (const { d, re } of candRes) {
      if (d.slug === f.device || f.alsoDevices.includes(d.slug)) continue;
      // Skip a sibling whose name contains or is contained in the entry's own device name
      // (minilogue vs minilogue xd): the entry text names the family, not another device.
      const own = deviceBySlug.get(f.device)?.name.toLowerCase().trim() ?? '';
      const other = d.name.toLowerCase().trim();
      if (own && (own.includes(other) || other.includes(own))) continue;
      if (!re.test(text)) continue;
      if (slugsByDevice.get(d.slug)?.has(f.slug)) continue;
      if (src && sourcesByDevice.get(d.slug)?.has(src)) continue;
      add({
        check: 'also-devices-candidate',
        key: `${f.ref} -> ${d.slug}`,
        files: [f.file, d.file],
        detail: `summary or install_notes mentions "${d.name}"; consider also_devices: ${d.slug}`,
        confidence: 'suspect',
      });
    }
  }

  // ---- drop accepted
  const accepted = new Set(config.accepted.map((a) => `${a.check}\u0000${a.key.toLowerCase()}`));
  const kept = findings.filter(
    (f) =>
      !accepted.has(`${f.check}\u0000${f.key.toLowerCase()}`) &&
      (!changedFiles || f.files.some((x) => changedFiles.has(x))),
  );

  const counts = Object.fromEntries(CHECKS.map((c) => [c, { clear: 0, suspect: 0 }])) as Record<
    Check,
    { clear: number; suspect: number }
  >;
  for (const f of kept) counts[f.check][f.confidence]++;

  writeFileSync(
    OUT_PATH,
    JSON.stringify({ generated: new Date().toISOString(), slice, nextCursor, wrapped, counts, findings: kept }, null, 2) + '\n',
  );

  if (values['json-only']) return;

  // ---- markdown
  const out: string[] = [];
  out.push('# Garden scan', '');
  out.push('| check | clear | suspect |', '| --- | ---: | ---: |');
  for (const c of CHECKS) out.push(`| ${c} | ${counts[c].clear} | ${counts[c].suspect} |`);
  out.push('');
  out.push(
    changedFiles
      ? `Changed since \`${(values.base as string | undefined) ?? 'HEAD'}\`: ${changedFiles.size} catalog files on ${slice.length} devices; findings limited to those files. Cursor unchanged.`
      : `Slice: ${slice.length} devices, ${sliceFwCount} firmware files, next cursor \`${nextCursor}\`${wrapped ? ' (wrapped)' : ''}.`,
    '',
    slice.join(', '),
    '',
  );
  if (proposerNote) out.push(`Note: ${proposerNote}`, '');
  if (values['no-based-on']) out.push('Note: based-on proposals skipped (--no-based-on).', '');

  for (const c of CHECKS) {
    if (reportChecks && !reportChecks.has(c)) continue;
    const all = kept.filter((f) => f.check === c);
    if (!all.length) continue;
    const sorted = [...all].sort(
      (a, b) =>
        Number(b.confidence === 'clear') - Number(a.confidence === 'clear') ||
        Number(b.inSlice) - Number(a.inSlice) ||
        a.key.localeCompare(b.key),
    );
    const isRelated = c.startsWith('related-');
    const fmt = (f: Finding) =>
      `- [${f.confidence}] ${f.inSlice ? '★ ' : ''}${f.key}: ${f.detail}${f.suggestion ? ` => ${f.suggestion}` : ''} (${f.files.join(', ')})`;
    out.push(`## ${c} (${counts[c].clear} clear, ${counts[c].suspect} suspect)`, '');
    if (c === 'also-devices-candidate') {
      // Prefer in-slice items under the cap, then the rest.
      const shown = sorted.slice(0, CANDIDATE_CAP);
      out.push(...shown.map(fmt));
      if (sorted.length > shown.length)
        out.push(`- noisy check, ${sorted.length} total; +${sorted.length - shown.length} more in garden-findings.json`);
    } else {
      const lines: string[] = [];
      let hidden = 0;
      sorted.forEach((f, i) => {
        if (i < SECTION_CAP || (isRelated && f.confidence === 'clear')) lines.push(fmt(f));
        else hidden++;
      });
      out.push(...lines);
      if (hidden) out.push(`- +${hidden} more in garden-findings.json`);
    }
    out.push('');
  }
  console.log(out.join('\n'));
}

main();
