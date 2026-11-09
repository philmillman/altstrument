/**
 * Shared GitHub access through the `gh` CLI (no token plumbing): REST via `gh()`,
 * and aliased-batch GraphQL via `graphql()`, which waits out rate limits.
 * Used by the discover skill and by scripts/metrics/fetch.ts.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

export type Obj = Record<string, unknown>;

export const asObj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
export const arr = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

export function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return str(v[0]);
  const o = asObj(v);
  return o ? str(o['#text']) : '';
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function progress(msg: string) {
  console.error(msg);
}

export const SEARCH_RATE_WAIT_MS = 70_000;
export const SEARCH_RATE_RETRIES = 4;

export type GhResult = { ok: true; json: unknown } | { ok: false; status?: number; message: string };

export const GH_OPTIONS = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000 } as const;

export function ghError(e: unknown): GhResult {
  const err = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
  if (err.code === 'ENOENT') return { ok: false, message: 'gh CLI not found; install it and run `gh auth login`' };
  const detail = `${err.stderr ?? ''}\n${err.stdout ?? ''}`;
  const status = /HTTP (\d{3})/.exec(detail)?.[1];
  const message = (err.stderr || err.message).split('\n').find((l) => l.trim()) ?? 'gh api failed';
  return { ok: false, status: status ? Number(status) : undefined, message: message.trim() };
}

export function gh(args: string[]): GhResult {
  try {
    const out = execFileSync('gh', ['api', ...args], { ...GH_OPTIONS, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, json: JSON.parse(out) as unknown };
  } catch (e) {
    return ghError(e);
  }
}

const execFileAsync = promisify(execFile);

export interface GqlItem {
  alias: string;
  /** Becomes GraphQL variables named `<alias>_<key>`; `field` receives a function that names them. */
  vars: Record<string, string>;
  field: (v: (key: string) => string) => string;
}

export type GqlResult =
  | { ok: true; data: Obj; errors: Map<string, string> }
  | { ok: false; limited: boolean; message: string };

/** One `gh api graphql` request carrying every item as an aliased root field. */
export async function graphqlOnce(items: GqlItem[]): Promise<GqlResult> {
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
export async function graphql(items: GqlItem[]): Promise<GqlResult> {
  for (let attempt = 0; ; attempt++) {
    const res = await graphqlOnce(items);
    if (res.ok || !res.limited || attempt >= SEARCH_RATE_RETRIES) return res;
    progress(`  GitHub rate limit; waiting ${SEARCH_RATE_WAIT_MS / 1000} s, then retrying (${attempt + 1}/${SEARCH_RATE_RETRIES})`);
    await sleep(SEARCH_RATE_WAIT_MS);
  }
}

