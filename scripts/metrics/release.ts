/**
 * The `metrics` GitHub release that holds the snapshot assets (see src/lib/repo-metrics.ts).
 *
 *   pnpm metrics:publish                 upload the asset the lock points to (from the local cache)
 *   pnpm metrics:prune-assets [--dry-run]
 *       delete assets older than KEEP_DAYS that no lock on origin/main has
 *       referenced in the last KEEP_DAYS days (needs the full history of main)
 *
 * Uses the `gh` CLI with its own auth (GH_TOKEN in Actions). Uploading creates the
 * release when it does not exist yet. Assets are never overwritten: an asset
 * already on the release is left alone.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { cachePath, LOCK_FILE, METRICS_REPO, METRICS_TAG, parseLock, readCachedAsset, readLock, type MetricsLock } from '../../src/lib/repo-metrics.ts';

const KEEP_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const ASSET_NAME = /^repo-metrics-[0-9a-f]{12}\.json$/;

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const tryRun = (cmd: string, args: string[]): string | undefined => {
  try {
    return run(cmd, args);
  } catch {
    return undefined;
  }
};

interface Asset {
  id: number;
  name: string;
  created_at: string;
}

function releaseExists(): boolean {
  return tryRun('gh', ['api', `repos/${METRICS_REPO}/releases/tags/${METRICS_TAG}`]) !== undefined;
}

function listAssets(): Asset[] {
  const rel = JSON.parse(run('gh', ['api', `repos/${METRICS_REPO}/releases/tags/${METRICS_TAG}`])) as { id: number };
  const out = run('gh', ['api', '--paginate', '--slurp', `repos/${METRICS_REPO}/releases/${rel.id}/assets?per_page=100`]);
  return (JSON.parse(out) as Asset[][]).flat();
}

/** Uploads the lock's asset from the cache unless the release has it already. */
export async function publish(root: string, lock: MetricsLock) {
  if (!readCachedAsset(root, lock)) {
    throw new Error(`${lock.asset} is not in the cache (or does not match ${LOCK_FILE}); run pnpm metrics:fetch first`);
  }
  if (!releaseExists()) {
    console.log(`Creating the "${METRICS_TAG}" release on ${METRICS_REPO}`);
    run('gh', [
      'release', 'create', METRICS_TAG,
      '--repo', METRICS_REPO,
      '--title', 'Quality metrics snapshots',
      '--notes', `GitHub metrics snapshots for the quality ratings, one asset per snapshot (content-addressed, never overwritten). ${LOCK_FILE} in the repo says which one a commit builds with.`,
      '--latest=false',
    ]);
  } else if (listAssets().some((a) => a.name === lock.asset)) {
    console.log(`${lock.asset} is already on the "${METRICS_TAG}" release`);
    return;
  }
  run('gh', ['release', 'upload', METRICS_TAG, cachePath(root, lock.asset), '--repo', METRICS_REPO]);
  console.log(`Uploaded ${lock.asset} to the "${METRICS_TAG}" release`);
}

/** Asset names referenced by the lock on `ref` at any point in the last KEEP_DAYS days. */
function referencedOnMain(ref: string): Set<string> {
  const names = new Set<string>();
  const lockAt = (commit: string) => {
    const text = tryRun('git', ['show', `${commit}:${LOCK_FILE}`]);
    if (!text) return;
    try {
      names.add(parseLock(text).asset);
    } catch {
      /* not a valid lock at that commit */
    }
  };
  // The lock as it was when the window opened, every change inside it, and the tip.
  const before = tryRun('git', ['rev-list', '-1', `--before=${KEEP_DAYS}.days`, ref])?.trim();
  if (before) lockAt(before);
  for (const c of (tryRun('git', ['log', `--since=${KEEP_DAYS}.days`, '--format=%H', ref, '--', LOCK_FILE]) ?? '').split('\n').filter(Boolean)) lockAt(c);
  lockAt(ref);
  return names;
}

function pruneAssets(root: string, ref: string, dryRun: boolean) {
  if (tryRun('git', ['rev-parse', '--verify', '-q', ref]) === undefined) throw new Error(`${ref} not found; fetch it first`);
  if (tryRun('git', ['rev-parse', '--is-shallow-repository'])?.trim() === 'true') throw new Error('This clone is shallow; pruning needs the history of main (fetch-depth: 0)');
  const keep = referencedOnMain(ref);
  const local = readLock(root);
  if (local) keep.add(local.asset);
  const cutoff = Date.now() - KEEP_DAYS * DAY_MS;
  const assets = listAssets();
  const doomed = assets.filter((a) => ASSET_NAME.test(a.name) && !keep.has(a.name) && Date.parse(a.created_at) < cutoff);
  console.log(`${assets.length} assets on the release, ${keep.size} referenced in the last ${KEEP_DAYS} days, ${doomed.length} to delete`);
  for (const a of doomed) {
    console.log(`  ${dryRun ? 'would delete' : 'deleting'} ${a.name} (uploaded ${a.created_at.slice(0, 10)})`);
    if (!dryRun) run('gh', ['api', '-X', 'DELETE', `repos/${METRICS_REPO}/releases/assets/${a.id}`]);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ROOT = new URL('../../', import.meta.url).pathname;
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean' }, ref: { type: 'string', default: 'origin/main' } },
  });
  const cmd = positionals[0];
  try {
    if (cmd === 'publish') {
      const lock = readLock(ROOT);
      if (!lock) throw new Error(`No ${LOCK_FILE}; run pnpm metrics:fetch first`);
      if (!existsSync(cachePath(ROOT, lock.asset))) throw new Error(`${lock.asset} is not in the local cache; publish where it was fetched`);
      await publish(ROOT, lock);
    } else if (cmd === 'prune') {
      pruneAssets(ROOT, values.ref!, !!values['dry-run']);
    } else {
      console.error('Usage: tsx scripts/metrics/release.ts (publish | prune [--dry-run] [--ref origin/main])');
      process.exit(2);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
