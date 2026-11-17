/** Where people reach the maintainer. Shown on /about#contact, /request and in the footer. */
export const CONTACT_EMAIL = 'hello@altstrument.org';
export const REPO_URL = 'https://github.com/philmillman/altstrument';
export const REQUEST_PATH = '/request';
/** User agent for every request this project makes to other sites (src/lib/polite-fetch.ts); explained at /about#crawling. */
export const BOT_USER_AGENT = 'altstrument-bot/1.0 (+https://altstrument.org/about#crawling)';
/**
 * Turnstile sitekey for the request form's widget (hostname altstrument.org). Public by design.
 * PUBLIC_TURNSTILE_SITEKEY overrides it, e.g. Cloudflare's testing key for a local `wrangler dev`.
 */
export const TURNSTILE_SITEKEY = '0x4AAAAAAGFQmte5zh_yHc3B';
/** Cloudflare's always-pass testing sitekey, used by `astro dev`. */
export const TURNSTILE_TEST_SITEKEY = '1x00000000000000000000AA';
