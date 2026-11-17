/**
 * The site is static assets; this Worker only answers POST /api/request (see
 * `run_worker_first` in wrangler.jsonc). Everything else is served from dist/
 * without running this code.
 *
 * /api/request turns the request form (src/pages/request.astro) into a GitHub
 * issue, so people without a GitHub account can ask for an entry to be added,
 * updated or removed. In order:
 *   1. POST with a same-origin Origin header, JSON body under MAX_BODY bytes;
 *   2. per-IP rate limit (REQUEST_LIMITER binding);
 *   3. field validation; a filled honeypot gets a fake success;
 *   4. Turnstile siteverify: success, action "request", and a hostname in
 *      TURNSTILE_HOSTNAMES. Results from Cloudflare's testing keys are refused
 *      unless TURNSTILE_ALLOW_TEST_KEYS=1 (local development only);
 *   5. POST /repos/{GITHUB_REPO}/issues with GITHUB_ISSUES_TOKEN.
 * REQUEST_DRY_RUN=1 stops before step 5 and returns the issue it would create.
 *
 * Secrets: GITHUB_ISSUES_TOKEN (fine-grained PAT, this repository only, Issues:
 * read and write), TURNSTILE_SECRET. See .dev.vars.example.
 */

interface Env {
  ASSETS: Fetcher;
  REQUEST_LIMITER?: RateLimit;
  GITHUB_REPO: string;
  TURNSTILE_HOSTNAMES: string;
  GITHUB_ISSUES_TOKEN?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_ALLOW_TEST_KEYS?: string;
  REQUEST_DRY_RUN?: string;
}

const ROUTE = '/api/request';
const MAX_BODY = 16 * 1024;
const TURNSTILE_ACTION = 'request';
const SITE_ORIGIN = 'https://altstrument.org';

const TYPES = ['add', 'update', 'remove'] as const;
type RequestType = (typeof TYPES)[number];

const TYPE_INFO: Record<RequestType, { title: string; label: string }> = {
  add: { title: 'New', label: 'new entry' },
  update: { title: 'Update', label: 'entry update' },
  remove: { title: 'Remove', label: 'removal request' },
};
const FORM_LABEL = 'via form';

interface RequestFields {
  type: RequestType;
  /** altstrument page the request is about (update/remove). */
  entry?: string;
  /** Device the new entry is for (add). */
  device?: string;
  /** Firmware or tool name (add). */
  project?: string;
  /** Source, homepage, release or evidence links, one per line. */
  links: string[];
  details: string;
  author: boolean;
  /** Remove and never list again (remove only). */
  exclude: boolean;
  /** How to reach the requester; shown publicly on the issue. */
  contact?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

// ---- validation -------------------------------------------------------------

function optionalText(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${field} is longer than ${max} characters`);
  return s || undefined;
}

function httpUrl(s: string, field: string): string {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, `${field}: "${s.slice(0, 80)}" is not a link`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, `${field} must be http(s) links`);
  return u.href;
}

function parseFields(body: unknown): RequestFields {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'expected a JSON object');
  const b = body as Record<string, unknown>;
  const type = b.type;
  if (typeof type !== 'string' || !(TYPES as readonly string[]).includes(type)) throw new HttpError(400, 'type must be add, update or remove');

  const entryRaw = optionalText(b.entry, 'Entry', 500);
  const entry = entryRaw ? httpUrl(entryRaw.startsWith('/') ? `${SITE_ORIGIN}${entryRaw}` : entryRaw, 'Entry') : undefined;
  const device = optionalText(b.device, 'Device', 200);
  const project = optionalText(b.project, 'Project', 200);
  const linksRaw = optionalText(b.links, 'Links', 2000);
  const links = (linksRaw ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((l) => httpUrl(l, 'Links'));
  if (links.length > 10) throw new HttpError(400, 'at most 10 links');
  const details = optionalText(b.details, 'Details', 5000);
  if (!details || details.length < 10) throw new HttpError(400, 'please describe the request in a sentence or two');
  const contact = optionalText(b.contact, 'Contact', 200);

  if (type === 'add' && !device && !project) throw new HttpError(400, 'name the device or the firmware to add');
  if (type !== 'add' && !entry) throw new HttpError(400, 'link the altstrument page this is about');

  return {
    type: type as RequestType,
    entry,
    device,
    project,
    links,
    details,
    author: b.author === true,
    exclude: type === 'remove' && b.exclude === true,
    contact,
  };
}

// ---- issue text ---------------------------------------------------------------

/** Plain text safe to drop into markdown: no HTML, no @mentions, no checklists or headings. */
function neutralize(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '@​');
}

const quote = (s: string) =>
  neutralize(s)
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join('\n');

/** One line, for titles and short fields. */
const oneLine = (s: string, max: number) => {
  const flat = neutralize(s).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function entryName(f: RequestFields): string {
  if (f.type === 'add') return [f.project, f.device && `for ${f.device}`].filter(Boolean).join(' ') || 'new entry';
  try {
    const parts = new URL(f.entry!).pathname.split('/').filter(Boolean);
    return parts.slice(1).join('/') || f.entry!;
  } catch {
    return f.entry!;
  }
}

function buildIssue(f: RequestFields): { title: string; body: string; labels: string[] } {
  const info = TYPE_INFO[f.type];
  const title = `[${info.title}]: ${oneLine(entryName(f), 100)}`;
  const sections: string[] = [];
  const add = (heading: string, text: string) => sections.push(`### ${heading}\n\n${text}`);

  if (f.entry) add('Entry URL', `<${f.entry}>`);
  if (f.device) add('Device', oneLine(f.device, 200));
  if (f.project) add('Firmware or tool', oneLine(f.project, 200));
  add('Details', quote(f.details));
  if (f.links.length) add('Links', f.links.map((l) => `- <${l}>`).join('\n'));
  if (f.type === 'remove') {
    add('Exclude permanently', f.exclude ? 'Yes: add it to `src/data/exclusions.yaml` so it is never listed again.' : 'No: remove the entry only.');
  }
  add('Requester', [f.author ? 'Says they are one of the authors.' : 'Not an author.', f.contact ? `Contact: ${oneLine(f.contact, 200)}` : 'No contact given.'].join('\n'));
  sections.push('---\n_Submitted through the request form on altstrument.org. The text above is the requester\'s own and has not been checked._');

  return { title, body: sections.join('\n\n'), labels: [info.label, FORM_LABEL] };
}

// ---- Turnstile -------------------------------------------------------------------

interface SiteverifyResult {
  success?: boolean;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
  metadata?: { result_with_testing_key?: boolean };
}

async function verifyTurnstile(env: Env, token: unknown, ip: string | null): Promise<void> {
  const hostnames = new Set(
    (env.TURNSTILE_HOSTNAMES ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  );
  if (!env.TURNSTILE_SECRET || hostnames.size === 0) throw new HttpError(503, 'the request form is not configured yet');
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
    throw new HttpError(403, 'the bot check did not complete; please try again');
  }
  let result: SiteverifyResult;
  try {
    const params: Record<string, string> = { secret: env.TURNSTILE_SECRET, response: token };
    if (ip) params.remoteip = ip;
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`siteverify ${r.status}`);
    result = (await r.json()) as SiteverifyResult;
  } catch {
    // Fail closed.
    throw new HttpError(403, 'the bot check could not be verified; please try again');
  }
  // Cloudflare's testing secret passes every token, reports hostname example.com and no action.
  const testing = result.metadata?.result_with_testing_key === true;
  if (testing && env.TURNSTILE_ALLOW_TEST_KEYS !== '1') throw new HttpError(403, 'the bot check failed');
  if (result.success !== true || (!testing && result.action !== TURNSTILE_ACTION) || !hostnames.has(result.hostname ?? '')) {
    throw new HttpError(403, 'the bot check failed; please try again');
  }
}

// ---- GitHub ------------------------------------------------------------------------

async function createIssue(env: Env, issue: ReturnType<typeof buildIssue>): Promise<{ number: number; url: string }> {
  if (!env.GITHUB_ISSUES_TOKEN) throw new HttpError(503, 'the request form is not configured yet');
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_ISSUES_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'altstrument-request-form',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(issue),
  });
  if (!res.ok) {
    console.error(`GitHub issue create failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    throw new HttpError(502, 'GitHub did not accept the request; please try again later or email hello@altstrument.org');
  }
  const data = (await res.json()) as { number: number; html_url: string };
  return { number: data.number, url: data.html_url };
}

// ---- handler --------------------------------------------------------------------------

async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'use POST' }, { Allow: 'POST' });
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) throw new HttpError(403, 'cross-site requests are not accepted');
  if (!(request.headers.get('Content-Type') ?? '').startsWith('application/json')) throw new HttpError(415, 'send JSON');
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY) throw new HttpError(413, 'request too large');

  const ip = request.headers.get('CF-Connecting-IP');
  if (env.REQUEST_LIMITER) {
    const { success } = await env.REQUEST_LIMITER.limit({ key: ip ?? 'unknown' });
    if (!success) throw new HttpError(429, 'too many requests; please wait a minute');
  }

  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'request too large');
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'expected a JSON object');
  }
  const fields = parseFields(body);
  // Honeypot: a field people can't see. Pretend it worked so bots learn nothing.
  if (typeof body.website === 'string' && body.website.trim()) return json(200, { ok: true });

  await verifyTurnstile(env, body.token, ip);
  const issue = buildIssue(fields);
  if (env.REQUEST_DRY_RUN === '1') return json(200, { ok: true, dryRun: true, issue });
  const created = await createIssue(env, issue);
  return json(201, { ok: true, ...created });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== ROUTE) return env.ASSETS.fetch(request);
    try {
      return await handleRequest(request, env);
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      console.error(e);
      return json(500, { error: 'something went wrong; please try again or email hello@altstrument.org' });
    }
  },
} satisfies ExportedHandler<Env>;
