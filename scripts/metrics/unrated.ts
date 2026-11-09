/**
 * Lists the firmware entries a range of commits adds or changes whose GitHub source
 * is not in the metrics snapshot yet (they show no rating until it is topped up).
 * Prints Markdown, or nothing when every entry is covered.
 *
 *   tsx scripts/metrics/unrated.ts --base <ref> --head <ref>
 *
 * Used by .github/workflows/metrics-topup.yml for PRs from forks. The head's files
 * are read as data with `git show` (never checked out or run), and the snapshot is
 * the one locked in the working tree (the base branch).
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { loadMetrics, parseGithubSource } from '../../src/lib/repo-metrics.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const { values } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' } } });
if (!values.base || !values.head) {
  console.error('Usage: tsx scripts/metrics/unrated.ts --base <ref> --head <ref>');
  process.exit(2);
}

const git = (args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const files = git(['diff', '-z', '--no-renames', '--name-only', '--diff-filter=AM', `${values.base}...${values.head}`, '--', 'src/content/firmwares'])
  .split('\0')
  .filter((f) => /^src\/content\/firmwares\/[^/]+\/[^/]+\.yaml$/.test(f));

const snap = await loadMetrics(ROOT);
const unrated: { id: string; name: string; source: string }[] = [];
for (const file of files) {
  let data: Record<string, unknown> | undefined;
  try {
    data = parse(git(['show', `${values.head}:${file}`])) as Record<string, unknown>;
  } catch {
    continue; // validation reports broken YAML
  }
  const source = typeof data?.source === 'string' ? data.source : undefined;
  const gh = parseGithubSource(source);
  if (!gh) continue;
  const covered = !!snap?.repos[gh.key] && (!gh.pathKey || !!snap.paths[gh.pathKey]);
  if (covered || (snap && gh.key in snap.missing)) continue;
  const id = file.replace(/^src\/content\/firmwares\//, '').replace(/\.yaml$/, '');
  unrated.push({ id, name: typeof data?.name === 'string' ? data.name : id, source: source! });
}

if (unrated.length) {
  const esc = (s: string) => s.replace(/[|`<>[\]]/g, (c) => `\\${c}`);
  console.log(
    `${unrated.length === 1 ? 'This entry has' : `These ${unrated.length} entries have`} no GitHub metrics yet, so ${unrated.length === 1 ? 'it shows' : 'they show'} no quality rating. ` +
      'PRs from forks cannot update the metrics snapshot; it is topped up automatically after merge.\n',
  );
  for (const u of unrated) console.log(`- ${esc(u.name)} (\`${u.id.replace(/`/g, '')}\`)`);
}
