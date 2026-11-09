/**
 * Propose `based_on` values for firmware entries whose derivation is only stated in prose.
 *
 *   tsx scripts/metrics/propose-based-on.ts [--out <dir>] [--no-gh]   write proposals (json + md)
 *   tsx scripts/metrics/propose-based-on.ts --apply [--out <dir>]     write `based_on:` for the
 *                                                                     `confident` rows of the json
 *
 * Classes: confident | ambiguous | unresolved | github-fork (see classify()).
 * --apply inserts one line after `homepage:` (else `source:`, else `license_notes:`/`license:`)
 * and never re-serialises the YAML or overwrites an existing `based_on`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const ROOT = resolve(import.meta.dirname, '../..');
const FW_DIR = process.env.FW_DIR ?? join(ROOT, 'src/content/firmwares');
/** Proposals and the gh cache go here unless --out says otherwise (gitignored with node_modules). */
const DEFAULT_OUT = join(ROOT, 'node_modules/.cache/based-on-proposals');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const NO_GH = args.includes('--no-gh');
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? resolve(args[outIdx + 1]) : DEFAULT_OUT;
const JSON_PATH = join(OUT, 'based-on-proposals.json');
const MD_PATH = join(OUT, 'based-on-proposals.md');

interface Entry {
  file: string; // <device>/<slug>.yaml
  ref: string; // <device>/<slug>
  device: string;
  slug: string;
  name: string;
  summary: string;
  description: string;
  source?: string;
  alsoDevices: string[];
  basedOn?: string;
  repo?: string; // lowercased owner/name when source is github
}

type Cls = 'confident' | 'ambiguous' | 'unresolved' | 'github-fork';
interface Row {
  file: string;
  class: Cls;
  phrase: string;
  proposed?: string;
  candidates?: string[];
  extracted?: string;
  github_url?: string;
  reason?: string;
}

// ---------- loading ----------

function loadEntries(): Entry[] {
  const out: Entry[] = [];
  for (const device of readdirSync(FW_DIR)) {
    const dir = join(FW_DIR, device);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    } catch {
      continue;
    }
    for (const f of files) {
      const y = parse(readFileSync(join(dir, f), 'utf8')) ?? {};
      const slug = f.replace(/\.yaml$/, '');
      const m = /github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(y.source ?? '');
      out.push({
        file: `${device}/${f}`,
        ref: `${device}/${slug}`,
        device,
        slug,
        name: String(y.name ?? slug),
        summary: String(y.summary ?? ''),
        description: String(y.description ?? ''),
        source: y.source,
        alsoDevices: y.also_devices ?? [],
        basedOn: y.based_on,
        repo: m ? `${m[1]}/${m[2].replace(/\.git$/, '')}`.toLowerCase() : undefined,
      });
    }
  }
  return out;
}

// ---------- name normalisation and index ----------

const VERSION = /^(v\d+([.\-]\d+)*[a-z]?|\d+(\.\d+)+[a-z]?)$/i;
const TRAILING_GENERIC = /(firmware|fw|os|custom|project|repo|repository|source|code)$/;
const GENERIC_REPO = new Set([
  'firmware', 'fw', 'main', 'master', 'src', 'os', 'app', 'apps', 'custom', 'customfirmware', 'code', 'tools',
  'release', 'releases', 'project', 'synth', 'midi', 'daisy', 'patches', 'plugin', 'plugins', 'modules', 'docs',
  'mod', 'hack', 'stock', 'tracker', 'sequencer', 'sampler', 'drums', 'editor', 'bootloader', 'updater', 'flasher',
]);

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/\s+/)
    .filter((t) => !VERSION.test(t))
    .join('')
    .replace(/[^a-z0-9]/g, '');
}
function keysOf(s: string): string[] {
  const k = norm(s);
  const keys = new Set([k]);
  const stripped = k.replace(TRAILING_GENERIC, '');
  if (stripped.length >= 3) keys.add(stripped);
  return [...keys].filter((x) => x.length >= 3);
}

function buildIndex(entries: Entry[]) {
  const idx = new Map<string, Set<Entry>>();
  const add = (key: string, e: Entry) => {
    if (!idx.has(key)) idx.set(key, new Set());
    idx.get(key)!.add(e);
  };
  for (const e of entries) {
    for (const k of keysOf(e.name)) add(k, e);
    for (const k of keysOf(e.slug.replace(/-/g, ' '))) add(k, e);
    if (e.repo) {
      const rn = e.repo.split('/')[1];
      for (const k of keysOf(rn.replace(/[-_]/g, ' '))) if (!GENERIC_REPO.has(k)) add(k, e);
    }
  }
  const byRepo = new Map<string, Entry[]>();
  for (const e of entries) if (e.repo) byRepo.set(e.repo, [...(byRepo.get(e.repo) ?? []), e]);
  return { idx, byRepo };
}

// ---------- phrase extraction ----------

interface Hit {
  phrase: string; // quoted sentence
  kind: string;
  strong: boolean;
  where: 'summary' | 'description';
  tokens: string[]; // candidate X token run (after the cue), or [] for suffix-style
  before: string[]; // tokens before cue ("X fork")
  urls: string[];
  idx: number; // sentence index within its field
  tail: string; // raw sentence text after the cue
}

const DET = new Set(['the', 'a', 'an', 'its', 'their', 'this', 'that', 'his', 'her', 'our', 'one', 'some']);
// Cues. strong = clear derivation statement.
const CUES: { re: RegExp; kind: string; strong: boolean }[] = [
  { re: /\b(?:hard[- ])?fork(?:ed)?\s+(?:of|from)\b/gi, kind: 'fork of', strong: true },
  { re: /\bbased\s+(?:directly\s+)?on\b/gi, kind: 'based on', strong: true },
  { re: /\bport(?:ed)?\s+(?:of|from|to)?\b/gi, kind: 'port of', strong: false },
  { re: /\bderived\s+from\b/gi, kind: 'derived from', strong: true },
  { re: /\bbuilt\s+on\b/gi, kind: 'built on', strong: false },
  { re: /\b(?:descended|descends)\s+from\b/gi, kind: 'descended from', strong: true },
  { re: /\b(?:spin-?off|offshoot|variant|continuation|successor)\s+of\b/gi, kind: 'variant of', strong: true },
  { re: /\bupstream(?: project)?(?: is| of)?\b/gi, kind: 'upstream', strong: false },
];
const FORK_SUFFIX = /((?:[A-Za-z0-9][\w.!+&'’-]*\s+){0,4}[A-Za-z0-9][\w.!+&'’-]*)\s+fork\b/g;

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function cleanTokens(span: string): string[] {
  return span
    .split(/\s+/)
    .map((t) => t.replace(/^[("'‘“]+/, '').replace(/[.,;:)"'’”!?]+$/, ''))
    .filter(Boolean);
}

function extractHits(e: Entry): Hit[] {
  const hits: Hit[] = [];
  const parts: ['summary' | 'description', string][] = [
    ['summary', e.summary],
    ['description', e.description],
  ];
  for (const [where, text] of parts) {
    sentences(text).forEach((sent, sidx) => {
      const urls = [...sent.matchAll(/https?:\/\/github\.com\/[^\s)]+/gi)].map((m) => m[0].replace(/[.,;]+$/, ''));
      for (const cue of CUES) {
        cue.re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = cue.re.exec(sent))) {
          const before = sent.slice(0, m.index);
          if ((before.match(/\(/g) ?? []).length > (before.match(/\)/g) ?? []).length) continue; // inside a parenthetical aside
          const after = sent.slice(m.index + m[0].length);
          const span = after.split(/[,;:()—]|\.\s|\.$/)[0];
          const tokens = cleanTokens(span).slice(0, 6);
          if (tokens.length === 0 && urls.length === 0) continue;
          // a summary that opens with "Port of X" / "X port of Y" states what the entry is
          const strong = cue.strong || (cue.kind === 'port of' && where === 'summary' && sidx === 0 && /^(?:[\w'\u2019 -]{0,25} )?[Pp]ort of /.test(sent));
          hits.push({ phrase: sent, kind: cue.kind, strong, where, tokens, before: [], urls, idx: sidx, tail: after });
        }
      }
      FORK_SUFFIX.lastIndex = 0;
      let fm: RegExpExecArray | null;
      while ((fm = FORK_SUFFIX.exec(sent))) {
        const before = cleanTokens(fm[1]);
        // "fork of" is handled by the cue above
        if (/^of\b/i.test(sent.slice(fm.index + fm[0].length).trim())) continue;
        hits.push({ phrase: sent, kind: 'X fork', strong: true, where, tokens: [], before, urls, idx: sidx, tail: '' });
      }
    });
  }
  return hits;
}

// ---------- resolution ----------

function lookup(idx: Map<string, Set<Entry>>, s: string): Entry[] {
  for (const k of keysOf(s)) {
    const hit = idx.get(k);
    if (hit?.size) return [...hit];
  }
  return [];
}

/** Longest-prefix resolution of a token run; drops determiners and a leading possessive owner. */
function resolveTokens(idx: Map<string, Set<Entry>>, tokens: string[], suffixMode: boolean): { x: string; cands: Entry[]; rest: string[] } | null {
  let t = tokens.slice();
  let detDropped = false;
  while (t.length && DET.has(t[0].toLowerCase())) {
    t.shift();
    detDropped = true;
  }
  if (!t.length) return null;
  const tryRun = (run: string[]) => {
    const lens = suffixMode ? run.map((_, i) => i) : run.map((_, i) => run.length - i);
    for (const l of lens) {
      const sub = suffixMode ? run.slice(l) : run.slice(0, l);
      if (!sub.length) continue;
      const joined = sub.join(' ');
      const c = lookup(idx, joined);
      if (c.length) return { x: joined, cands: c, rest: suffixMode ? [] : run.slice(l) };
    }
    return null;
  };
  let r = tryRun(t);
  if (!r && /['’]s$/.test(t[0]) && t.length > 1) r = tryRun(t.slice(1));
  void detDropped;
  return r;
}

function repoFromUrl(u: string): string | undefined {
  const m = /github\.com\/([^/\s]+)\/([^/\s#?)]+)/i.exec(u);
  return m ? `${m[1]}/${m[2].replace(/\.git$/, '')}`.toLowerCase() : undefined;
}

const GENERIC_NAMES = new Set(['community', 'official', 'stock', 'original', 'factory', 'main', 'base', 'open', 'custom', 'standard', 'default', 'classic', 'modular', 'editor', 'update', 'updater', 'fm1', 'smk37', 'mvave', 'groovebox', 'sequencer', 'sampler']);
const ALLOWED_AFTER = /^(fm-?1|pro|elite|plus|mini|open|firmware|fw|os)$/i;
const COMPONENT_NOUN = /^(host|platform|framework|runtime|library|lib|engine|engines|editor|sdk|template|emulator|core|module|modules|plugin|plugins|effect|filter|dsp|model|models|algorithm|voice)$/i;

function pickTier(e: Entry, cands: Entry[]): Entry[] {
  const uniq = [...new Set(cands)].filter((c) => c !== e);
  const same = uniq.filter((c) => c.device === e.device);
  if (same.length) return same;
  const also = uniq.filter((c) => c.alsoDevices.includes(e.device) || e.alsoDevices.includes(c.device));
  if (also.length) return also;
  // cross-device: only distinctive names
  return uniq.filter((c) => {
    const k = norm(c.name);
    return !GENERIC_NAMES.has(k) && !GENERIC_NAMES.has(norm(c.slug)) && k.length >= 4;
  });
}

// ---------- libraries / generic nouns that are not firmware projects ----------

const NOT_PROJECT = new Set(
  [
    'daisy seed', 'libdaisy', 'daisysp', 'stmlib', 'juce', 'linux', 'raspberry pi', 'arduino', 'supercollider', 'platformio',
    'freertos', 'tinyusb', 'esp-idf', 'micropython', 'circuitpython', 'pico sdk', 'vcv rack', 'max/msp', 'pure data', 'puredata',
    'stock firmware', 'official firmware', 'factory firmware', 'coremidi', 'webmidi', 'electron', 'node', 'react', 'rust', 'python',
    'faust', 'gearmulator', // no-op safeguard; resolved normally if in catalog
  ].filter((x) => x !== 'gearmulator'),
);

// Hand demotions found in review that no cheap heuristic captures. Keyed by file; value is the reason.
const DEMOTE: Record<string, string> = {
  'm-vave-fm-1/fm1-doom.yaml': 'ports id Software\'s Doom; the catalog match is an unrelated Doom entry on another device',
  'm-vave-smk-37/x0x37.yaml': 'matched a GitHub fork name (genkigenki/fm1-x0x), the parent is charlesvestal X0X and the match picked a sibling fork',
  'sony-psp/pspattern.yaml': '"LittleGPTracker" is the upstream name; the catalog entry is the djdiskmachine fork, parent unclear',
  'korg-prologue/plaitsxplorer-elementsxplorer.yaml': 'two units, only ElementsXplorer is based on Elements',
  'm-vave-fm-1/dreadnought.yaml': 'started as a SLOOP fork but rewritten from 0.3 on its own platform',
  'm-vave-fm-1/fm1-time-signal-source.yaml': 'catalog match picked the MK-300 entry; the parent is the FM-1 open firmware',
  'm-vave-fm-1/fm1vst.yaml': 'runs firmware inside an emulator based on fm1-emu; not a derivative',
  'm-vave-fm-1/tonic.yaml': 'built on two platforms (fm1-base and felucca-bsp), no single parent',
  'teenage-engineering-op-xy/op-xy-mnmd.yaml': 'uses a fork of Open-XY as its build base; the project is the engine pack',
};

// ---------- proposal building ----------

function buildProposals(entries: Entry[]) {
  const { idx, byRepo } = buildIndex(entries);
  type Pre = { e: Entry; hits: { hit: Hit; x: string; cands: Entry[]; flag?: string }[]; unresolved: { hit: Hit; x: string; url?: string }[] };
  const pres: Pre[] = [];
  for (const e of entries) {
    const hits = extractHits(e);
    const pre: Pre = { e, hits: [], unresolved: [] };
    const seen = new Set<string>();
    for (const hit of hits) {
      let r: { x: string; cands: Entry[]; rest?: string[] } | null = null;
      // 1. github URL in the sentence that matches a catalog repo
      for (const u of hit.urls) {
        const repo = repoFromUrl(u);
        const c = repo ? byRepo.get(repo) : undefined;
        if (c?.length) {
          r = { x: u, cands: c };
          break;
        }
      }
      // 2. name resolution
      if (!r) r = resolveTokens(idx, hit.kind === 'X fork' ? hit.before : hit.tokens, hit.kind === 'X fork');
      if (r) {
        const lowered = r.x.toLowerCase();
        if (NOT_PROJECT.has(lowered) || NOT_PROJECT.has(norm(lowered))) continue;
        const real = pickTier(e, r.cands);
        if (!real.length) continue; // self-match only
        // a generic word ("community fork") must never resolve to an entry on another device
        if (real.every((c) => c.device !== e.device && !c.alsoDevices.includes(e.device)) && GENERIC_NAMES.has(norm(r.x))) continue;
        const key = `${hit.kind}|${real.map((c) => c.ref).join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let flag: string | undefined;
        // partial name: the catalog name is only the start of a longer proper name ("NAM A2 Lite" vs "NAM")
        const nextTok = r.rest?.[0];
        if (nextTok && /^[A-Z0-9]/.test(nextTok) && !VERSION.test(nextTok) && !ALLOWED_AFTER.test(nextTok)) {
          flag = `partial name match: "${r.x} ${r.rest!.slice(0, 2).join(' ')}"`;
        }
        if (!flag && nextTok && COMPONENT_NOUN.test(nextTok)) flag = `name is followed by a component noun ("${r.x} ${nextTok}")`;
        // "Bastl's kastle2", "joeSeggiola's Stages": a possessive owner that is not the matched entry's owner
        if (!flag && hit.kind !== 'X fork') {
          const own = hit.tokens.find((t) => /['\u2019]s$/.test(t));
          const ownIdx = own ? hit.tokens.indexOf(own) : -1;
          if (own && ownIdx <= 1 && !/^(the|its|their|this|author|project|maintainer|upstream)['\u2019]s$/i.test(own)) {
            const o = norm(own);
            const repoOwners = real.map((c) => (c.repo ? c.repo.split('/')[0].replace(/[^a-z0-9]/g, '') : ''));
            const ok = repoOwners.some((ro) => ro && (ro.includes(o) || o.includes(ro)));
            const noRepo = repoOwners.every((ro) => !ro);
            if (!ok && !noRepo) flag = `parent owner "${own}" does not match the catalog entry's repo owner`;
          }
        }
        // a second parent named right after the first ("X and Y", "X, Y", "X with Y")
        if (!flag && hit.kind !== 'X fork') {
          const at = hit.tail.toLowerCase().indexOf(r.x.toLowerCase());
          const rest = at >= 0 ? hit.tail.slice(at + r.x.length) : '';
          const nm = /^(?:\s+[\w.'\u2019-]*(?:\d[\d.]*|v\d\S*))?\s*(?:,|\band\b|\bplus\b|&|\bwith\b)\s+(?:the\s+)?([A-Z0-9][\w!.-]*(?:\s+[A-Z0-9][\w!.-]*)?)/.exec(rest);
          if (nm) {
            const more = pickTier(e, lookup(idx, nm[1])).filter((c) => !real.includes(c));
            if (more.length) {
              real.push(...more);
              flag = `several parents named ("${r.x}" and "${nm[1]}")`;
            }
          }
        }
        if (!flag && hit.kind !== 'X fork' && hit.kind !== 'fork of' && hit.kind !== 'variant of' && hit.where === 'description' && hit.idx > 1) {
          flag = 'cue appears late in the description, may describe a component';
        }
        pre.hits.push({ hit, x: r.x, cands: real, flag });
      } else if (hit.kind !== 'X fork') {
        // unresolved: keep only when X looks like a named project, not a generic noun or library
        const t = hit.tokens.slice();
        const startsDet = DET.has(t[0]?.toLowerCase() ?? '');
        const x = t.filter((w, i) => !(i === 0 && DET.has(w.toLowerCase()))).slice(0, 3).join(' ');
        const url = hit.urls[0];
        const named = /^[A-Z0-9]/.test(x) && !startsDet;
        if ((named || url) && x && !NOT_PROJECT.has(x.toLowerCase()) && hit.strong) {
          if (!pre.unresolved.some((u) => u.x === x)) pre.unresolved.push({ hit, x, url });
        }
      }
    }
    pres.push(pre);
  }
  return pres;
}

// ---------- github fork check ----------

type GhInfo = { isFork: boolean; parent?: string } | null;
function ghForkInfo(repos: string[], cachePath: string): Map<string, GhInfo> {
  let cache: Record<string, GhInfo> = {};
  try {
    cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch {
    /* none */
  }
  const need = repos.filter((r) => !(r in cache));
  if (!NO_GH) {
    for (let i = 0; i < need.length; i += 20) {
      const batch = need.slice(i, i + 20);
      const body = batch
        .map((r, j) => {
          const [o, n] = r.split('/');
          return `r${j}: repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(n)}) { isFork parent { nameWithOwner } }`;
        })
        .join('\n');
      let data: Record<string, { isFork: boolean; parent: { nameWithOwner: string } | null } | null> = {};
      try {
        const res = execFileSync('gh', ['api', 'graphql', '-f', `query=query { ${body} }`], {
          encoding: 'utf8',
          maxBuffer: 20 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        data = JSON.parse(res).data ?? {};
      } catch (err) {
        // partial results (e.g. a missing repo) come back on stdout with a non-zero exit
        const out = (err as { stdout?: string }).stdout;
        try {
          data = JSON.parse(out ?? '{}').data ?? {};
        } catch {
          console.error(`gh batch ${i / 20} failed`);
        }
      }
      batch.forEach((r, j) => {
        const v = data[`r${j}`];
        cache[r] = v ? { isFork: v.isFork, parent: v.parent?.nameWithOwner.toLowerCase() } : null;
      });
    }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 1));
  }
  return new Map(repos.map((r) => [r, cache[r] ?? null]));
}

// ---------- classification ----------

function quote(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 170 ? `${t.slice(0, 167)}...` : t;
}

function classify(entries: Entry[]): Row[] {
  const pres = buildProposals(entries);
  // GitHub fork info for entries that have any resolved hit
  const repos = [...new Set(pres.filter((p) => p.hits.length && p.e.repo).map((p) => p.e.repo!))];
  const gh = ghForkInfo(repos, join(OUT, 'based-on-gh-cache.json'));
  const rows: Row[] = [];

  for (const { e, hits, unresolved } of pres) {
    if (e.basedOn) continue; // never overwrite
    if (hits.length) {
      const strongHits = hits.filter((h) => h.hit.strong);
      const flagged = strongHits.length && strongHits.every((h) => h.flag) ? strongHits[0] : undefined;
      const pool = strongHits.length ? strongHits : hits;
      const targets = new Map<string, Entry>();
      for (const h of pool) for (const c of h.cands) targets.set(c.ref, c);
      const best = pool.find((h) => !h.flag) ?? pool[0];
      const phrase = quote(best.hit.phrase);
      const cands = [...targets.values()];

      // already a github fork of any candidate (or of a repo a candidate also forks from)
      const info = e.repo ? gh.get(e.repo) : null;
      if (info?.isFork && info.parent) {
        const parentHit = cands.find((c) => c.repo === info.parent);
        if (parentHit) {
          rows.push({ file: e.file, class: 'github-fork', phrase, proposed: parentHit.ref, reason: `GitHub fork of ${info.parent}` });
          continue;
        }
      }

      const weakOnly = strongHits.length === 0;
      const singleHit = pool.length === 1 && best.cands.length === 1;
      if (cands.length === 1 && !weakOnly && (singleHit || pool.every((h) => h.cands.length === 1))) {
        const c = cands[0];
        const demote = DEMOTE[e.file];
        const subjectOk = flagged?.flag ?? subjectCheck(e, best.hit);
        if (demote || subjectOk) {
          rows.push({
            file: e.file,
            class: 'ambiguous',
            phrase,
            proposed: c.ref,
            candidates: [c.ref],
            reason: demote ?? subjectOk!,
          });
        } else {
          rows.push({ file: e.file, class: 'confident', phrase, proposed: c.ref });
        }
      } else {
        rows.push({
          file: e.file,
          class: 'ambiguous',
          phrase,
          candidates: cands.map((c) => c.ref),
          reason: weakOnly ? `weak phrase (${best.hit.kind})` : (flagged?.flag ?? (cands.length > 1 ? 'several candidate entries' : 'phrase not decisive')),
        });
      }
    } else if (unresolved.length) {
      const u = unresolved[0];
      rows.push({
        file: e.file,
        class: 'unresolved',
        phrase: quote(u.hit.phrase),
        extracted: u.x,
        github_url: u.url,
      });
    }
  }
  // mutual derivation (A -> B and B -> A) is a sign that one of the matches is wrong
  const refOf = (file: string) => file.replace(/\.yaml$/, '');
  const prop = new Map(rows.filter((r) => r.class === 'confident').map((r) => [refOf(r.file), r.proposed!]));
  for (const r of rows) {
    if (r.class !== 'confident') continue;
    const other = prop.get(r.proposed!);
    if (other === refOf(r.file)) {
      r.class = 'ambiguous';
      r.candidates = [r.proposed!];
      r.reason = 'mutual derivation with the proposed parent';
    }
  }
  return rows;
}

/**
 * Returns a reason to demote when the cue sentence is probably not about this entry deriving from X:
 * a feature import ("ported from Skiff" for one effect), the cue in the second half of a long
 * description about something else, or the entry being named as the parent ("X is the base of ...").
 */
function subjectCheck(e: Entry, hit: Hit): string | null {
  const s = hit.phrase;
  // "other forks of X", "forks such as", "forks include": the entry is the parent, not a child
  if (/\b(?:forks|derivatives|ports)\b/i.test(s) && !/\bis an? (?:\w+ ){0,3}fork\b/i.test(s)) return 'sentence is about forks in general';
  // describing what the entry's output/feature is based on, not the entry
  if (/\b(?:can|will|lets?|allows?|reads?|loads?|imports?|exports?|supports?|runs?|compatible|files?|patches?|presets?|format|protocol|samples?|banks?)\b[^.]{0,60}\b(?:based on|built on|derived from)\b/i.test(s)) {
    return 'cue describes a file, format or feature rather than the project';
  }
  void e;
  return null;
}

// ---------- output ----------

function writeOutputs(rows: Row[]) {
  mkdirSync(OUT, { recursive: true });
  const order: Cls[] = ['confident', 'ambiguous', 'unresolved', 'github-fork'];
  rows.sort((a, b) => order.indexOf(a.class) - order.indexOf(b.class) || a.file.localeCompare(b.file));
  writeFileSync(JSON_PATH, JSON.stringify(rows, null, 2) + '\n');
  const esc = (s = '') => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines: string[] = ['# based_on proposals', ''];
  const counts = Object.fromEntries(order.map((c) => [c, rows.filter((r) => r.class === c).length]));
  lines.push(order.map((c) => `${c}: ${counts[c]}`).join(' | '), '');
  for (const c of order) {
    const rs = rows.filter((r) => r.class === c);
    if (!rs.length) continue;
    lines.push(`## ${c} (${rs.length})`, '');
    lines.push('| entry | phrase | proposed based_on | candidates / extracted | note |', '| --- | --- | --- | --- | --- |');
    for (const r of rs) {
      const cand = r.candidates ? r.candidates.join(', ') : [r.extracted, r.github_url].filter(Boolean).join(' ');
      lines.push(`| ${r.file} | ${esc(r.phrase)} | ${r.proposed ?? ''} | ${esc(cand)} | ${esc(r.reason)} |`);
    }
    lines.push('');
  }
  writeFileSync(MD_PATH, lines.join('\n'));
  console.log(counts);
  console.log(`wrote ${JSON_PATH}\nwrote ${MD_PATH}`);
}

// ---------- apply ----------

function applyRows() {
  const rows: Row[] = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  let done = 0;
  for (const r of rows.filter((x) => x.class === 'confident' && x.proposed)) {
    const path = join(FW_DIR, r.file);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split('\n');
    if (lines.some((l) => /^based_on:/.test(l))) continue;
    const find = (re: RegExp) => lines.findIndex((l) => re.test(l));
    // insert after the whole top-level key (multi-line values continue on indented/blank-free lines)
    const endOf = (i: number) => {
      let j = i;
      while (j + 1 < lines.length && /^\s+\S/.test(lines[j + 1])) j++;
      return j;
    };
    let at = find(/^homepage:/);
    if (at < 0) at = find(/^source:/);
    if (at < 0) at = find(/^license_notes:/);
    if (at < 0) at = find(/^license:/);
    if (at < 0) {
      console.warn(`no anchor in ${r.file}`);
      continue;
    }
    lines.splice(endOf(at) + 1, 0, `based_on: ${r.proposed}`);
    writeFileSync(path, lines.join('\n'));
    done++;
  }
  console.log(`applied based_on to ${done} files`);
}

if (APPLY) {
  applyRows();
} else {
  writeOutputs(classify(loadEntries()));
}
