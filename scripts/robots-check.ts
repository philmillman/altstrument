/**
 * May altstrument fetch this URL? Applies the same rules as src/lib/polite-fetch.ts:
 * the exclusion list (src/data/exclusions.yaml), robots.txt and, for AI use,
 * Content-Signal ai-input and the ClaudeBot / Claude-User / anthropic-ai groups.
 *
 *   pnpm robots:check <url> [<url>...]   AI use is assumed; --no-ai for a plain fetch.
 *                                        Exit 0 if every URL is allowed, 1 if any is not.
 *
 *   tsx scripts/robots-check.ts --hook   Claude Code PreToolUse hook for WebFetch
 *                                        (.claude/settings.json). Reads the hook JSON on
 *                                        stdin and denies the fetch, with the reason, when
 *                                        the URL may not be requested. Never blocks on its
 *                                        own bugs: anything unexpected lets the call through.
 */
import { checkUrl } from '../src/lib/polite-fetch';

async function hook(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let url: unknown;
  try {
    url = (JSON.parse(input) as { tool_input?: { url?: unknown } }).tool_input?.url;
  } catch {
    return;
  }
  if (typeof url !== 'string' || !url) return;
  const v = await checkUrl(url, { forAI: true });
  if (v.allowed) return;
  const reason =
    `Not fetching ${url}: ${v.reason}. altstrument honours robots.txt, Content-Signal and its exclusion list ` +
    `(see /about#crawling). Don't work around this with another tool or a mirror; record the page as a lead ` +
    `if it matters, or use the gh API for GitHub listings.`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }),
  );
}

async function cli(args: string[]): Promise<number> {
  const forAI = !args.includes('--no-ai');
  const urls = args.filter((a) => !a.startsWith('--'));
  if (!urls.length) {
    console.error('usage: pnpm robots:check [--no-ai] <url> [<url>...]');
    return 2;
  }
  let refused = 0;
  for (const url of urls) {
    const v = await checkUrl(url, { forAI });
    if (v.allowed) console.log(`allowed  ${url}${v.crawlDelayS ? ` (Crawl-delay ${v.crawlDelayS}s)` : ''}`);
    else {
      refused++;
      console.log(`refused  ${url}\n         ${v.kind}: ${v.reason}`);
    }
  }
  return refused ? 1 : 0;
}

const args = process.argv.slice(2);
if (args.includes('--hook')) {
  await hook().catch((e) => console.error(`robots-check hook: ${(e as Error).message}`));
} else {
  process.exitCode = await cli(args);
}
