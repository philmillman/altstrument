/**
 * Adds missing GitHub releases to the firmware entries a branch changes.
 *
 *   pnpm releases:sync --base origin/main            report what is missing
 *   pnpm releases:sync --base origin/main --write    add it to the files
 *   pnpm releases:sync --base <sha> --head <ref>     report on another ref (read with git show)
 *   ... --notice                                     the short version for a fork PR comment
 *   pnpm releases:sync --write src/content/firmwares/x/y.yaml ...   named files only
 *
 * Only entries the branch adds or modifies are looked at, so a contributor who
 * updates an entry for a new release gets its versions[] row without typing it,
 * and nothing else in the catalog changes under them. The release sweep in
 * /discover covers the rest of the catalog.
 *
 * Which releases count, newest first, stopping at the first one versions[] lists
 * (the anchor):
 *   - published GitHub releases; not drafts, and not pre-releases unless the
 *     entry already lists one;
 *   - for repos with no releases, tags (dated by their commit), with
 *     `notes: Git tag; no GitHub release page.` as CONTRIBUTING asks;
 *   - not dated before the newest date in versions[];
 *   - tagged the way the entry's versions are: the same words around the numbers
 *     (other components of a monorepo, e.g. `smk-` builds in an FM-1 repo, are
 *     skipped).
 * Entries are left alone, and reported, when the repo's recent releases don't
 * include the anchor and nothing is dated to compare with, when the top version is
 * a `<branch> @ <sha>` commit (switching to releases needs a person), when
 * versions[] is empty, or when more than MAX_ADD releases are missing.
 *
 * New rows are inserted as text at the top of versions[], in the file's own
 * indentation, so the rest of the file is untouched. Rows carry version, date and
 * url only, with the version spelled like the entry's (`1.2` rather than `v1.2`
 * when the entry drops the v); a `notes:` line in your own words is still welcome.
 *
 * stdout gets a markdown report (empty when there is nothing to say). With
 * --notice it is the comment for a fork PR instead: its releases are added after
 * merge (the push to main runs this with --write), so the comment only says so and
 * lists the entries that will need a person; no YAML to paste. Progress
 * goes to stderr. GitHub is reached through the `gh` CLI. Exit 0 unless the
 * command line is wrong (2) or GitHub could not be reached (1).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';
import { arr, asObj, graphql, progress, str, type GqlItem, type Obj } from '../lib/github.ts';
import {
  COMMIT_VERSION,
  GITHUB_SOURCE,
  isoDay,
  listed,
  SWEEP_SKIP_REPOS,
  type VersionRow,
} from '../lib/releases.ts';

const FIRMWARE_FILE = /^src\/content\/firmwares\/[^/]+\/[^/]+\.ya?ml$/;
const MAX_ADD = 5;
const BATCH = 20;
const TAG_NOTE = 'Git tag; no GitHub release page.';
/** Tag names that are safe in YAML, markdown and URLs. Others never match an entry's style anyway. */
const SAFE_TAG = /^[\w.+\-/]+$/;

// The report becomes a PR comment, and entry names, paths and versions come from the PR,
// tag names from upstream repos: escape them so they can't add links, mentions or markup.
/** Inline code span; code spans render nothing inside them. */
const code = (s: string) => '`' + (s.replace(/[`\r\n]/g, '') || ' ') + '`';
/** Plain text: markdown punctuation escaped, @mentions broken with a zero-width space. */
const text = (s: string) =>
  s
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\`*_{}[\]()<>#+!|~&]/g, '\\$&')
    .replace(/@/g, '@\u200b');

interface NewRow extends VersionRow {
  notes?: string;
}

interface Entry {
  file: string;
  name: string;
  repo: string;
  versions: VersionRow[];
  raw: string;
}

interface Outcome {
  entry: Entry;
  rows: NewRow[];
  skipped: string[];
  /** Why nothing was added, when the entry was left alone on purpose. */
  held?: string;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string' },
    head: { type: 'string' },
    write: { type: 'boolean', default: false },
    notice: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.error('Usage: pnpm releases:sync [--base <ref> [--head <ref>]] [--write | --notice] [file ...]');
  process.exit(0);
}
if (!values.base && positionals.length === 0) {
  console.error('releases:sync: pass --base <ref> or the files to check');
  process.exit(2);
}
if (values.write && values.notice) {
  console.error('releases:sync: --notice only reports, so it cannot be combined with --write');
  process.exit(2);
}
if (values.write && values.head) {
  console.error('releases:sync: --write edits the working tree, so it cannot be combined with --head');
  process.exit(2);
}

const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Firmware files added or modified since the merge base with --base, committed or not. */
function changedFiles(): string[] {
  if (positionals.length) return positionals.filter((f) => FIRMWARE_FILE.test(f));
  const base = values.base!;
  const range = values.head ? [`${base}...${values.head}`] : [git(['merge-base', base, 'HEAD']).trim()];
  return git(['diff', '-z', '--no-renames', '--diff-filter=AM', '--name-only', ...range, '--', 'src/content/firmwares'])
    .split('\0')
    .filter((f) => FIRMWARE_FILE.test(f));
}

const readEntry = (file: string) => (values.head ? git(['show', `${values.head}:${file}`]) : readFileSync(file, 'utf8'));

function loadEntries(files: string[], notes: string[]): Entry[] {
  const entries: Entry[] = [];
  for (const file of files) {
    let raw: string;
    let fw: Obj | undefined;
    try {
      raw = readEntry(file);
      fw = asObj(parse(raw));
    } catch (e) {
      notes.push(`${code(file)}: could not read it (${text((e as Error).message.split('\n')[0])})`);
      continue;
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
    entries.push({ file, name: str(fw.name) || file, repo, versions, raw });
  }
  return entries;
}

interface Ref {
  name: string;
  date: string;
  url: string;
  prerelease: boolean;
}

interface RepoRefs {
  releases: Ref[];
  tags: Ref[];
}

const COMMIT_DATE = '... on Commit { committedDate }';
const REPO_FIELDS =
  'releases(first: 20, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { tagName isDraft isPrerelease publishedAt createdAt url } } ' +
  `refs(refPrefix: "refs/tags/", first: 20, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) { nodes { name target { ${COMMIT_DATE} ... on Tag { target { ${COMMIT_DATE} } } } } }`;

function parseRepo(repo: string, o: Obj): RepoRefs {
  const releases = arr(asObj(o.releases)?.nodes)
    .map(asObj)
    .filter((r): r is Obj => !!r && r.isDraft !== true && SAFE_TAG.test(str(r.tagName)))
    .map((r) => ({
      name: str(r.tagName),
      date: isoDay(str(r.publishedAt) || str(r.createdAt)),
      url: str(r.url) || `https://github.com/${repo}/releases/tag/${encodeURIComponent(str(r.tagName))}`,
      prerelease: r.isPrerelease === true,
    }));
  const tags = arr(asObj(o.refs)?.nodes)
    .map(asObj)
    .filter((t): t is Obj => !!t && SAFE_TAG.test(str(t.name)))
    .map((t) => {
      const target = asObj(t.target);
      const date = str(target?.committedDate) || str(asObj(target?.target)?.committedDate);
      return { name: str(t.name), date: date ? isoDay(date) : '', url: `https://github.com/${repo}/tree/${encodeURIComponent(str(t.name))}`, prerelease: false };
    });
  return { releases, tags };
}

async function fetchRepos(repos: string[]): Promise<Map<string, RepoRefs | string>> {
  const out = new Map<string, RepoRefs | string>();
  for (let i = 0; i < repos.length; i += BATCH) {
    const batch = repos.slice(i, i + BATCH);
    const items: GqlItem[] = batch.map((repo, j) => {
      const [owner, name] = repo.split('/');
      return { alias: `r${j}`, vars: { owner, name }, field: (v) => `repository(owner: ${v('owner')}, name: ${v('name')}) { ${REPO_FIELDS} }` };
    });
    const res = await graphql(items);
    if (!res.ok) throw new Error(`GitHub: ${res.message}`);
    batch.forEach((repo, j) => {
      const o = asObj(res.data[`r${j}`]);
      out.set(repo.toLowerCase(), o ? parseRepo(repo, o) : (res.errors.get(`r${j}`) ?? 'repository not found'));
    });
  }
  return out;
}

function plan(entry: Entry, refs: RepoRefs): Outcome {
  const out: Outcome = { entry, rows: [], skipped: [] };
  const top = entry.versions[0];
  const fromTags = refs.releases.length === 0;
  const candidates = fromTags ? refs.tags : refs.releases;
  if (!top) {
    return candidates.length ? { ...out, held: 'versions[] is empty, so there is nothing to tell which releases are new' } : out;
  }
  if (COMMIT_VERSION.test(top.version)) {
    const newest = refs.releases.find((r) => !r.prerelease) ?? refs.tags[0];
    return newest ? { ...out, held: `the top version is a commit (${code(top.version)}) and the repo now has ${code(newest.name)}; replace the commit row by hand` } : out;
  }
  const anchored = candidates.some((r) => listed(entry.versions, r.name));
  const lastDate = entry.versions.reduce<string | undefined>((max, v) => (v.date && (!max || v.date > max) ? v.date : max), undefined);
  if (!anchored && !lastDate) {
    return candidates.length
      ? { ...out, held: `none of the repo's ${candidates.length} most recent ${fromTags ? 'tags' : 'releases'} is in versions[] and no version is dated, so it is unclear which are new` }
      : out;
  }
  // Monorepos tag several components: `smk-1.2`, `palindrome-v1.1`, `v0.46-smk37`, plain `v0.6.0`.
  // Take only tags whose words (letters other than a lone v) match a listed version's, as
  // written or as tagged in its URL, or all appear in the entry's own name.
  const words = (tag: string) => [...new Set(tag.toLowerCase().match(/[a-z]+/g) ?? [])].filter((w) => w !== 'v').sort();
  const tagOf = (url?: string) => /\/(?:tag|tree)\/([^/?#]+)\/?$/.exec(url ?? '')?.[1];
  const known = new Set(
    entry.versions.flatMap((v) => [v.version, tagOf(v.url)].filter((x): x is string => !!x).map((x) => words(safeDecode(x)).join(' '))),
  );
  const ownName = `${entry.repo.split('/')[1]} ${entry.name}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ours = (tag: string) => {
    const w = words(tag);
    return known.has(w.join(' ')) || (w.length > 0 && w.every((x) => ownName.includes(x)));
  };
  // Follow the entry's spelling when it drops the tag's leading v (`1.1.1` for tag v1.1.1).
  const dropV = !/^v\d/i.test(top.version) && tagOf(top.url) !== undefined && safeDecode(tagOf(top.url)!).toLowerCase() === `v${top.version.toLowerCase()}`;
  const spell = (tag: string) => (dropV ? tag.replace(/^v(?=\d)/i, '') : tag);
  // Pre-releases count when the entry already lists one.
  const takesPre = candidates.some((r) => r.prerelease && listed(entry.versions, r.name));
  const rows: NewRow[] = [];
  const others: string[] = [];
  const pre: string[] = [];
  for (const r of candidates) {
    if (listed(entry.versions, r.name)) break;
    // Without the anchor, only what is strictly newer than the newest dated version.
    if (lastDate && (anchored ? r.date < lastDate : r.date <= lastDate)) continue;
    if (fromTags && !r.date) continue;
    if (r.prerelease && !takesPre) pre.push(r.name);
    else if (!ours(r.name)) others.push(r.name);
    else rows.push({ version: spell(r.name), date: r.date || undefined, url: r.url, notes: fromTags ? TAG_NOTE : undefined });
  }
  const list = (xs: string[]) =>
    xs.slice(0, 5).map(code).join(', ') + (xs.length > 5 ? ` and ${xs.length - 5} more` : '');
  if (pre.length) out.skipped.push(`pre-release${pre.length > 1 ? 's' : ''} ${list(pre)}`);
  if (others.length) out.skipped.push(`${list(others)}, tagged like another component of the repo`);
  if (rows.length > MAX_ADD) {
    return { ...out, held: `${rows.length} ${fromTags ? 'tags' : 'releases'} are missing (more than ${MAX_ADD}); add the ones that matter by hand` };
  }
  // Keep versions[] newest first even when a release has an older date than the one above it.
  rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return { ...out, rows };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const scalar = (v: string) => stringify(v).trimEnd();

function rowsYaml(rows: NewRow[], indent: string): string {
  return rows
    .map((r) => {
      const lines = [`${indent}- version: ${scalar(r.version)}`];
      if (r.date) lines.push(`${indent}  date: ${r.date}`);
      lines.push(`${indent}  url: ${scalar(r.url!)}`);
      if (r.notes) lines.push(`${indent}  notes: ${scalar(r.notes)}`);
      return lines.join('\n') + '\n';
    })
    .join('');
}

/** The file with `rows` inserted at the top of versions[], or an error message. */
function insertRows(raw: string, rows: NewRow[]): { edited: string } | { error: string } {
  const m = /^versions:[ \t]*\r?\n((?:[ \t]*#.*\r?\n)*)([ \t]*)- /m.exec(raw);
  if (!m) return { error: 'could not find a block-style versions: list to insert into' };
  const at = m.index + m[0].length - m[2].length - 2;
  const edited = raw.slice(0, at) + rowsYaml(rows, m[2]) + raw.slice(at);
  // The edit must parse back to exactly the new rows on top of the old ones.
  try {
    const before = arr(asObj(parse(raw))?.versions);
    const after = arr(asObj(parse(edited))?.versions);
    const ok =
      after.length === before.length + rows.length &&
      rows.every((r, i) => str(asObj(after[i])?.version) === r.version) &&
      JSON.stringify(after.slice(rows.length)) === JSON.stringify(before);
    if (!ok) return { error: 'the edited file did not parse back as expected' };
  } catch (e) {
    return { error: `the edited file did not parse (${(e as Error).message.split('\n')[0]})` };
  }
  return { edited };
}

function report(outcomes: Outcome[], notes: string[], wrote: boolean): string {
  const L: string[] = [];
  const added = outcomes.filter((o) => o.rows.length);
  if (added.length) {
    L.push(wrote ? '### Releases added to versions[]' : '### Releases missing from versions[]', '');
    if (!wrote) L.push('Add these at the top of `versions[]` (newest first); a short `notes:` line in your own words is welcome:', '');
    for (const o of added) {
      L.push(`**${text(o.entry.name)}** (${code(o.entry.file)}, [${o.entry.repo}](https://github.com/${o.entry.repo}/releases))`, '');
      L.push('```yaml', 'versions:', rowsYaml(o.rows, '  ').trimEnd(), '```', '');
    }
  }
  const other = [
    ...outcomes.filter((o) => o.held).map((o) => `**${text(o.entry.name)}** (${code(o.entry.file)}): left alone; ${o.held}.`),
    ...outcomes.flatMap((o) => o.skipped.map((s) => `**${text(o.entry.name)}**: skipped ${s}.`)),
    ...notes,
  ];
  if (other.length) {
    L.push('### Release check notes', '', ...other.map((s) => `- ${s}`), '');
  }
  return L.join('\n');
}

/** The fork PR comment: releases come after merge; only what needs a person is listed. */
function notice(outcomes: Outcome[], notes: string[]): string {
  const held = [
    ...outcomes.filter((o) => o.held).map((o) => `**${text(o.entry.name)}** (${code(o.entry.file)}): ${o.held}.`),
    ...notes,
  ];
  if (!outcomes.some((o) => o.rows.length) && !held.length) return '';
  const L = [
    'New GitHub releases and tags are added to `versions[]` automatically after merge, so there is no need to add them by hand.',
    '',
  ];
  if (held.length) L.push('These entries will not be updated automatically, so check their `versions[]` by hand:', '', ...held.map((s) => `- ${s}`), '');
  return L.join('\n');
}

const output = (outcomes: Outcome[], notes: string[]) =>
  values.notice ? notice(outcomes, notes) : report(outcomes, notes, values.write);

async function main() {
  const notes: string[] = [];
  const entries = loadEntries(changedFiles(), notes);
  if (!entries.length) {
    progress('releases:sync: no changed entries with a GitHub source');
    process.stdout.write(output([], notes));
    return;
  }
  progress(`releases:sync: checking ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
  const repos = [...new Map(entries.map((e) => [e.repo.toLowerCase(), e.repo])).values()];
  const refs = await fetchRepos(repos);

  const outcomes: Outcome[] = [];
  for (const entry of entries) {
    const r = refs.get(entry.repo.toLowerCase());
    if (typeof r === 'string' || !r) {
      notes.push(`**${text(entry.name)}** (${code(entry.file)}): could not read ${entry.repo} (${text(r ?? 'no answer')}).`);
      continue;
    }
    const o = plan(entry, r);
    if (o.rows.length && values.write) {
      const res = insertRows(entry.raw, o.rows);
      if ('error' in res) {
        notes.push(`**${text(entry.name)}** (${code(entry.file)}): not edited; ${text(res.error)}.`);
        continue;
      }
      writeFileSync(entry.file, res.edited);
      progress(`  ${entry.file}: added ${o.rows.map((x) => x.version).join(', ')}`);
    }
    outcomes.push(o);
  }
  process.stdout.write(output(outcomes, notes));
}

main().catch((e) => {
  console.error(`releases:sync: ${(e as Error).message}`);
  process.exit(1);
});
