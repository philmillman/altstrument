/**
 * The opt-out list in src/data/exclusions.yaml: projects, authors and sites that
 * asked not to be listed. Enforced by scripts/validate.ts, the /discover gather,
 * src/lib/polite-fetch.ts and the WebFetch hook (scripts/robots-check.ts).
 * No Astro imports, so scripts can use it.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'astro/zod';
import { makeUrlMatcher } from './url-match';

export const EXCLUSIONS_FILE = 'src/data/exclusions.yaml';

export const exclusionSchema = z
  .object({
    url: z.string().min(1),
    reason: z.string().optional(),
    date: z.union([z.string(), z.date()]).optional(),
    issue: z.string().url().optional(),
    except: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type Exclusion = z.infer<typeof exclusionSchema>;

const fileSchema = z.object({ exclusions: z.array(exclusionSchema).default([]) }).strict();

/** Parses the exclusion list. Throws with a readable message when the file is malformed. */
export function loadExclusions(path = new URL('../data/exclusions.yaml', import.meta.url)): Exclusion[] {
  const raw = parse(readFileSync(path, 'utf8')) ?? {};
  const res = fileSchema.safeParse(raw);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`${EXCLUSIONS_FILE}: ${msg}`);
  }
  return res.data.exclusions;
}

let cached: ((url: string) => Exclusion | undefined) | undefined;

/** The exclusion a URL falls under, if any. The list is read once per process. */
export function excludedBy(url: string): Exclusion | undefined {
  cached ??= makeUrlMatcher(loadExclusions());
  return cached(url);
}
