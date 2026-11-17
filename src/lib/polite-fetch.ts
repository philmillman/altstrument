/**
 * The one way this project requests third-party web pages, feeds and media.
 * No Astro imports, so scripts, the content loader and the discover gather all
 * use it. The policy is described for site owners at /about#crawling.
 *
 * Before any request:
 *   1. the URL must not be on the opt-out list (src/data/exclusions.yaml);
 *   2. the site's robots.txt must allow it. Groups for `altstrument-bot` or
 *      `altstrument` apply if present, otherwise `*`. When the content will be
 *      read by an AI model (`forAI`, e.g. the /discover agent), groups for
 *      ClaudeBot, Claude-User and anthropic-ai are obeyed too;
 *   3. with `forAI`, a robots.txt `Content-Signal: ai-input=no` (contentsignals.org)
 *      for those groups blocks the request.
 * robots.txt follows RFC 9309: a 4xx answer means no rules, a 5xx or network
 * failure means "assume everything is disallowed" for this run. Each origin's
 * robots.txt is fetched once per process.
 *
 * Requests to one host are spaced by the site's Crawl-delay (capped at 30 s) or
 * the caller's `minIntervalMs`, whichever is larger. Redirects are followed by
 * hand so every hop gets the same checks. 429 and 5xx are retried with backoff,
 * honouring Retry-After up to a minute.
 *
 * A refused URL throws SkippedError: callers report it as skipped, never as
 * a broken link.
 *
 * Not routed through here, on purpose: documented APIs used as APIs (api.github.com,
 * the `gh` CLI), which are governed by their API terms rather than robots.txt, and
 * our own release assets (src/lib/repo-metrics.ts). Callers opt out of the robots
 * check with `robots: false` only for those.
 */
import robotsParser from 'robots-parser';
import { excludedBy } from './exclusions';
import { BOT_USER_AGENT } from './contact';

export const USER_AGENT = BOT_USER_AGENT;
/** robots.txt product tokens that address this project's fetchers. */
export const BOT_TOKENS = ['altstrument-bot', 'altstrument'] as const;
/** Tokens also obeyed when the fetched content is read by an AI model. */
export const AI_TOKENS = ['claudebot', 'claude-user', 'anthropic-ai'] as const;

const MAX_CRAWL_DELAY_S = 30;
const MAX_RETRY_WAIT_S = 60;
const MAX_REDIRECTS = 5;
const ROBOTS_TIMEOUT_MS = 10_000;

export type SkipKind = 'excluded' | 'robots' | 'content-signal' | 'robots-unreachable';

export type Verdict =
  | { allowed: true; crawlDelayS?: number }
  | { allowed: false; kind: SkipKind; reason: string };

export class SkippedError extends Error {
  constructor(
    readonly url: string,
    readonly kind: SkipKind,
    readonly reason: string,
  ) {
    super(`skipped ${url}: ${reason}`);
    this.name = 'SkippedError';
  }
}

export interface CheckOptions {
  /** The content will be read by an AI model (the /discover agent and its gather). */
  forAI?: boolean;
}

// ---- robots.txt --------------------------------------------------------------

interface RobotsFile {
  status: 'rules' | 'none' | 'unreachable';
  detail?: string;
  robots?: ReturnType<typeof robotsParser>;
  /** Lowercased user-agent tokens that have their own group. */
  groups: Set<string>;
  /** Content-Signal values per lowercased user-agent token. */
  signals: Map<string, Record<string, string>>;
}

/** Group names and Content-Signal lines, which robots-parser does not expose. */
function scanGroups(text: string): Pick<RobotsFile, 'groups' | 'signals'> {
  const groups = new Set<string>();
  const signals = new Map<string, Record<string, string>>();
  let current: string[] = [];
  let inAgents = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!inAgents) current = [];
      inAgents = true;
      const token = value.toLowerCase().split('/')[0].trim();
      current.push(token);
      groups.add(token);
      continue;
    }
    inAgents = false;
    if (field === 'content-signal') {
      const parsed: Record<string, string> = {};
      for (const pair of value.split(',')) {
        const [k, v] = pair.split('=').map((s) => s.trim().toLowerCase());
        if (k && v) parsed[k] = v;
      }
      for (const ua of current) signals.set(ua, { ...signals.get(ua), ...parsed });
    }
  }
  return { groups, signals };
}

const robotsCache = new Map<string, Promise<RobotsFile>>();

async function loadRobots(origin: string): Promise<RobotsFile> {
  const robotsUrl = `${origin}/robots.txt`;
  const empty = { groups: new Set<string>(), signals: new Map() };
  try {
    // RFC 9309 asks crawlers to follow at least five redirects for robots.txt; fetch does.
    const res = await fetch(robotsUrl, {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain, */*;q=0.5' },
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
    });
    if (res.status >= 500 || res.status === 429) {
      await res.body?.cancel();
      return { status: 'unreachable', detail: `robots.txt answered HTTP ${res.status}`, ...empty };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { status: 'none', ...empty };
    }
    const text = await res.text();
    return { status: 'rules', robots: robotsParser(robotsUrl, text), ...scanGroups(text) };
  } catch (e) {
    return { status: 'unreachable', detail: `robots.txt could not be fetched (${(e as Error).message})`, ...empty };
  }
}

function robotsFor(url: URL): Promise<RobotsFile> {
  const origin = url.origin;
  let p = robotsCache.get(origin);
  if (!p) {
    p = loadRobots(origin);
    robotsCache.set(origin, p);
  }
  return p;
}

/** Whether this project may request `url`, and the site's Crawl-delay if it set one. */
export async function checkUrl(url: string, opts: CheckOptions = {}): Promise<Verdict> {
  const ex = excludedBy(url);
  if (ex) {
    return { allowed: false, kind: 'excluded', reason: `on the exclusion list (${ex.url}${ex.reason ? `: ${ex.reason}` : ''})` };
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { allowed: false, kind: 'robots', reason: 'not a valid URL' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { allowed: false, kind: 'robots', reason: `unsupported scheme ${u.protocol}` };

  const file = await robotsFor(u);
  if (file.status === 'unreachable') return { allowed: false, kind: 'robots-unreachable', reason: file.detail ?? 'robots.txt unreachable' };
  if (file.status === 'none' || !file.robots) return { allowed: true };

  // Our own group if the site wrote one, otherwise `*`; plus the AI crawlers' groups when relevant.
  const own = BOT_TOKENS.filter((t) => file.groups.has(t));
  const tokens: string[] = own.length ? [...own] : ['*'];
  if (opts.forAI) tokens.push(...AI_TOKENS.filter((t) => file.groups.has(t)));

  for (const t of tokens) {
    if (file.robots.isAllowed(url, t) === false) {
      return { allowed: false, kind: 'robots', reason: `robots.txt disallows it for User-agent: ${t}` };
    }
  }
  if (opts.forAI) {
    for (const t of tokens) {
      if (file.signals.get(t)?.['ai-input'] === 'no') {
        return { allowed: false, kind: 'content-signal', reason: `robots.txt Content-Signal ai-input=no for User-agent: ${t}` };
      }
    }
  }
  const delays = tokens.map((t) => file.robots!.getCrawlDelay(t)).filter((d): d is number => typeof d === 'number' && d > 0);
  return delays.length ? { allowed: true, crawlDelayS: Math.min(Math.max(...delays), MAX_CRAWL_DELAY_S) } : { allowed: true };
}

// ---- requests ------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Next time a request to each host may start. Reserved before waiting, so concurrent callers queue. */
const nextSlot = new Map<string, number>();

async function waitForSlot(host: string, intervalMs: number): Promise<void> {
  if (intervalMs <= 0) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + intervalMs);
  if (at > now) await sleep(at - now);
}

export interface PoliteInit extends CheckOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Attempts for 429 / 5xx / network errors. Default 3. */
  tries?: number;
  /** Minimum gap between requests to one host; the site's Crawl-delay wins if longer. */
  minIntervalMs?: number;
  /** Skip robots.txt (never the exclusion list). Only for documented APIs used as APIs. */
  robots?: boolean;
}

async function checkOrThrow(url: string, init: PoliteInit): Promise<number> {
  if (init.robots === false) {
    const ex = excludedBy(url);
    if (ex) throw new SkippedError(url, 'excluded', `on the exclusion list (${ex.url})`);
    return 0;
  }
  const v = await checkUrl(url, init);
  if (!v.allowed) throw new SkippedError(url, v.kind, v.reason);
  return (v.crawlDelayS ?? 0) * 1000;
}

/**
 * fetch() with the checks above. Returns the final response after redirects (any status
 * but 429/5xx, which are retried); throws SkippedError when a URL may not be requested,
 * otherwise the last error once the tries run out.
 */
export async function politeFetch(url: string, init: PoliteInit = {}): Promise<Response> {
  const tries = init.tries ?? 3;
  let lastErr: unknown;
  let waitMs = 0;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await sleep(waitMs || 500 * 2 ** attempt);
    waitMs = 0;
    try {
      let current = url;
      for (let hop = 0; ; hop++) {
        const delayMs = await checkOrThrow(current, init);
        await waitForSlot(new URL(current).host, Math.max(delayMs, init.minIntervalMs ?? 0));
        const res = await fetch(current, {
          method: init.method ?? 'GET',
          redirect: 'manual',
          headers: { 'User-Agent': USER_AGENT, ...init.headers },
          signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
        });
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
          await res.body?.cancel();
          if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
          current = new URL(location, current).href;
          continue;
        }
        if (res.status >= 500 || res.status === 429) {
          lastErr = new Error(`HTTP ${res.status}`);
          const retryAfter = Number(res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset'));
          if (res.status === 429 && retryAfter > 0 && retryAfter <= MAX_RETRY_WAIT_S) waitMs = (retryAfter + 1) * 1000;
          await res.body?.cancel();
          break;
        }
        return res;
      }
    } catch (e) {
      if (e instanceof SkippedError) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

