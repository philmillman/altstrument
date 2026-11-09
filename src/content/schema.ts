/**
 * Shared Zod schemas for the catalog.
 *
 * Used by both Astro's content collections (src/content.config.ts) and the
 * standalone validator (scripts/validate.ts), so the rules live in one place.
 */
import { z } from 'astro/zod';
import { youtubeId } from '../lib/media';

export const CATEGORIES = [
  'synth',
  'groovebox',
  'sampler',
  'drum-machine',
  'controller',
  'foot-controller',
  'pedal',
  'eurorack',
  'diy-platform',
  'handheld',
  'tools',
  'other',
] as const;

export const CATEGORY_LABELS: Record<Category, string> = {
  synth: 'Synths',
  groovebox: 'Grooveboxes',
  sampler: 'Samplers',
  'drum-machine': 'Drum machines',
  controller: 'Controllers',
  'foot-controller': 'Foot controllers',
  pedal: 'Pedals & multi-FX',
  eurorack: 'Eurorack & modular',
  'diy-platform': 'DIY platforms',
  handheld: 'Consoles & handhelds',
  tools: 'Cross-device tools',
  other: 'Other',
};

export const STATUSES = [
  'active', // commits or releases within roughly the last year
  'maintained', // stable, infrequent updates, author still responsive
  'dormant', // no activity for a long time, still usable
  'archived', // explicitly archived or abandoned by the author
  'announced', // publicly announced, nothing downloadable yet
  'unknown',
] as const;

export const SOURCE_STATUSES = [
  'open', // full source published
  'patcher-only', // patch tooling is public, the firmware changes themselves are not
  'binary-only', // only compiled images are distributed
  'closed', // nothing public
] as const;

export const DISTRIBUTIONS = [
  'download', // prebuilt image you flash yourself
  'browser-installer', // WebMIDI / WebUSB installer page
  'patch-your-own', // tool patches a stock firmware file you supply
  'commercial', // paid
  'source-only', // you must build it yourself
] as const;

export const KINDS = [
  'firmware', // replaces or modifies what runs on the device
  'tool', // host-side tool that supports the scene (editor, flasher, emulator, SDK)
] as const;

/**
 * Accepted license values: an SPDX identifier from this list, or one of the
 * two sentinels. Extend the list when a new license shows up in the catalog.
 */
export const LICENSES = [
  'MIT',
  'MIT-0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'ISC',
  'Apache-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'MPL-2.0',
  'Unlicense',
  'WTFPL',
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-NC-4.0',
  'CC-BY-NC-SA-4.0',
  'CC-BY-SA-3.0',
  'CC-BY-NC-SA-3.0',
  'PolyForm-Noncommercial-1.0.0',
  'Elastic-2.0',
  'proprietary', // sentinel: all rights reserved / custom non-open terms
  'unspecified', // sentinel: no license file or statement found
] as const;

/** http(s) only: these land in href/src attributes, so javascript: and data: must not parse. */
const url = z.url({ protocol: /^https?$/ });
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase kebab-case');

export const linkSchema = z.object({
  label: z.string().min(1),
  url,
});

/**
 * A device photo we are allowed to redistribute. Files live under
 * public/images/devices/ and are pre-sized (max 1200px wide). Credit and
 * license are shown on the device page; never add an image without them.
 */
export const imageSchema = z.object({
  /** Site-relative path, e.g. /images/devices/elektron-octatrack.svg */
  src: z.string().regex(/^\/images\/devices\/[a-z0-9-]+\.(svg|jpg|png|webp)$/),
  /**
   * photo: a redistributable photograph, shown as-is.
   * line-art: our own monochrome vector rendering produced by tools/lineart
   * from a product image (black strokes on transparent; the UI inverts it in
   * dark mode). Credit names the product image it was drawn after.
   */
  style: z.enum(['photo', 'line-art']).default('photo'),
  alt: z.string().min(1).max(200),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Who to credit, e.g. "Photo: Jane Doe" or "Elektron press kit". */
  credit: z.string().min(1),
  /** SPDX id (CC-BY-SA-4.0, CC0-1.0, ...) or a short phrase such as "manufacturer press kit, reuse permitted". */
  license: z.string().min(1),
  /** Page the image was taken from, where the license can be verified. */
  source_url: url,
  /** Optional: the original file URL. */
  original_url: url.optional(),
});

/**
 * A manufacturer logo used as the fallback visual when a device has no
 * product image. Only logos we may redistribute: public-domain text logos
 * (Wikimedia Commons PD-textlogo / PD-simple / CC0) or a manufacturer press
 * kit that permits use. Files live under public/images/logos/.
 */
export const logoSchema = z.object({
  src: z.string().regex(/^\/images\/logos\/[a-z0-9-]+\.(svg|png|webp|jpg)$/),
  alt: z.string().min(1).max(200),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  credit: z.string().min(1),
  /** e.g. "public domain (text logo)", "CC0-1.0", "manufacturer press kit" */
  license: z.string().min(1),
  source_url: url,
  original_url: url.optional(),
  /** true when the logo is a single dark colour, so the UI may invert it in dark mode */
  monochrome: z.boolean().default(true),
});

/**
 * One file per manufacturer under src/content/manufacturers/<slug>.yaml,
 * where <slug> = slugify(name) and name matches the `manufacturer` string
 * used on device files exactly.
 */
export const manufacturerSchema = z.object({
  name: z.string().min(1),
  website: url.optional(),
  logo: logoSchema.optional(),
  notes: z.string().optional(),
});

/** Public quality ratings; keep in step with RATINGS in src/lib/quality.ts. */
export const QUALITY_RATINGS = ['foundational', 'established', 'rising', 'notable'] as const;

/** Quality settings on an entry: a hand-set score (with a reason) that replaces the computed one, and/or `hide`. */
export const entryQualitySchema = z
  .object({
    score: z.number().int().min(0).max(100).optional(),
    reason: z.string().min(1).optional(),
    /** Show no quality score for this entry (it still sorts by its score). */
    hide: z.boolean().optional(),
    /** Hand-set public rating, replacing the computed one. */
    rating: z.enum(QUALITY_RATINGS).optional(),
  })
  .refine((q) => q.score !== undefined || q.hide || q.rating, { message: 'set score, rating or hide' })
  .refine((q) => q.score === undefined || q.reason, { message: 'a hand-set score needs a reason', path: ['reason'] });

export const deviceSchema = z.object({
  name: z.string().min(1),
  manufacturer: z.string().min(1),
  category: z.enum(CATEGORIES),
  /** ISO date the device joined the catalog. Drives the homepage's latest devices. */
  added: z.coerce.date(),
  /** Short free-text, e.g. "pocket FM synth" or "8-track sampler". */
  tagline: z.string().max(140).optional(),
  /** What the device is: plain factual prose, blank lines between paragraphs. Shown first on the device page. */
  description: z.string().optional(),
  /** MCU / SoC / DSP family. Useful for cross-linking similar hardware. */
  platform: z.string().optional(),
  /** The stock OS version most mods currently target. */
  stock_firmware: z.string().optional(),
  links: z
    .object({
      manufacturer: url.optional(),
      community: z.array(linkSchema).default([]),
    })
    .default({ community: [] }),
  /** Device-level caveats: brick risk, policy notes, "no custom firmware exists". */
  notes: z.string().optional(),
  /** Other devices that share firmware or hardware (device slugs). */
  related: z.array(slug).default([]),
  image: imageSchema.optional(),
  /**
   * Hide this device's dormant and archived entries whose newest dated version
   * is more than this many years before the build date (see src/lib/stale.ts).
   * Hidden entries keep their own page (noindex) but leave lists, counts,
   * search, feeds and the sitemap.
   */
  hide_stale_after_years: z.number().int().positive().optional(),
  /**
   * Entry slugs (file names under firmwares/<device>/) shown first in this
   * device's firmware and tool lists, in this order. Pinned entries are never
   * hidden by hide_stale_after_years.
   */
  pinned: z.array(slug).default([]),
  /**
   * Device-level quality scoring (see src/lib/quality.ts and /about/quality).
   * `shared_repo`: entries whose source is inside this monorepo share one score,
   * computed for the repo itself plus this device's community links, because
   * the repo and community exist at the device level. `score` + `reason`: a
   * hand-set device score; it replaces the shared score, or without
   * `shared_repo` applies to every entry whose primary device this is.
   * `hide`: show no quality score for any entry whose primary device this is.
   */
  quality: z
    .object({
      shared_repo: url.optional(),
      score: z.number().int().min(0).max(100).optional(),
      reason: z.string().min(1).optional(),
      hide: z.boolean().optional(),
      rating: z.enum(QUALITY_RATINGS).optional(),
    })
    .refine((q) => q.shared_repo || q.score !== undefined || q.hide || q.rating, { message: 'set shared_repo, score, rating or hide' })
    .refine((q) => q.score === undefined || q.reason, { message: 'a hand-set score needs a reason', path: ['reason'] })
    .optional(),
});

export const authorSchema = z.object({
  name: z.string().min(1),
  url: url.optional(),
});

export const versionSchema = z.object({
  version: z.string().min(1),
  /** ISO date. Omit rather than guess. */
  date: z.coerce.date().optional(),
  url: url.optional(),
  notes: z.string().optional(),
});

/**
 * A demo video for a firmware. YouTube only; the page embeds `video` with a
 * click-to-load youtube-nocookie player and lists any `videos` under it.
 * validate.ts checks each one against YouTube's oEmbed endpoint, so removed or
 * non-embeddable videos fail the build.
 */
export const videoSchema = z.object({
  /** Watch, youtu.be, shorts or live URL. A t= offset is honoured. */
  url,
  /** Video title, from oEmbed. */
  title: z.string().min(1).optional(),
  /** Channel name, from oEmbed. */
  credit: z.string().min(1).optional(),
  /** Linked from the firmware's own README / homepage / release notes, or uploaded by its authors. */
  first_party: z.boolean().default(false),
  /** The page that linked the video, when first_party. */
  found_via: url.optional(),
  /** The release the video shows, matching a `versions[].version` string. */
  version: z.string().min(1).optional(),
});

/**
 * A hotlinked screenshot or photo, used only when no video exists. Not copied
 * into the repo; validate.ts checks that the URL still serves an image.
 */
export const firmwareImageSchema = z.object({
  /** Direct https image URL (raw.githubusercontent.com, project site), never a github.com/.../blob/ page. */
  url,
  alt: z.string().min(1).max(200),
  credit: z.string().min(1),
  /** Page the image appears on. */
  source_url: url,
  first_party: z.boolean().default(false),
});

export const firmwareBaseSchema = z.object({
  /**
   * Other devices this same entry targets (device slugs). The file stays under
   * its primary `device` and keeps one page there; every listed device shows
   * it in its lists, and site totals count it once. Only for the same build
   * and text: device-specific ports get their own file.
   */
  also_devices: z.array(slug).default([]),
  name: z.string().min(1),
  kind: z.enum(KINDS).default('firmware'),
  summary: z.string().min(1).max(280),
  /** Longer free text, plain prose. */
  description: z.string().optional(),
  status: z.enum(STATUSES).default('unknown'),
  authors: z.array(authorSchema).min(1),
  source: url.optional(),
  source_status: z.enum(SOURCE_STATUSES),
  license: z.enum(LICENSES),
  /** When the license needs a qualifier, e.g. "patch/ directory excluded" or "+ linking exception". */
  license_notes: z.string().optional(),
  /** Primary non-repo link: project site, forum thread, installer page. */
  homepage: url.optional(),
  /**
   * The entry this one derives from when that is not visible as a GitHub fork
   * (copied code, a port, a hard fork re-uploaded as a new repo). Either a
   * catalog entry `<device>/<slug>` or the parent's repo URL. GitHub forks are
   * detected from the metrics snapshot and need no `based_on`.
   */
  based_on: z.union([url, z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/)]).optional(),
  /** The project's own Discord, subreddit or forum, not the device's (that goes on the device). */
  community: z.array(linkSchema).default([]),
  /**
   * Quality settings: `score` + `reason` replace the computed score (e.g. for a
   * mirror repo whose GitHub numbers mislead); `hide` shows no score.
   */
  quality: entryQualitySchema.optional(),
  distribution: z.enum(DISTRIBUTIONS).optional(),
  /** Which stock firmware version(s) this targets, if specific. */
  requires_stock: z.string().optional(),
  install_notes: z.string().optional(),
  /**
   * Set when installing can leave the device unrecoverable without a
   * programmer, opening the case or a factory repair. A failed boot that a
   * documented recovery fixes does not count. See CONTRIBUTING "Setting brick_risk".
   */
  brick_risk: z.boolean().default(false),
  tags: z.array(z.string().regex(/^[a-z0-9-]+$/)).default([]),
  versions: z.array(versionSchema).default([]),
  /** The main video, embedded on the page and used as the card thumbnail. */
  video: videoSchema.optional(),
  /**
   * More videos, e.g. the walkthrough for each earlier release. Newest first.
   * Listed under `video`, which must be set and should be the newest.
   */
  videos: z.array(videoSchema).default([]),
  /** Fallback visual when there is no video. */
  image: firmwareImageSchema.optional(),
  /**
   * Set on entries a build-time loader creates from an upstream data file
   * (e.g. a repo's info.yaml). Points at that file. Such entries have no file
   * in this repo; fix them upstream instead.
   */
  generated_from: url.optional(),
});

/**
 * Cross-field rules that Zod enforces for both Astro and the validator.
 */
export function refineFirmware<T extends z.ZodType<FirmwareData>>(schema: T) {
  return schema.superRefine((fw, ctx) => {
    if (fw.source_status === 'open' && !fw.source) {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'source URL is required when source_status is "open"',
      });
    }
    if (fw.source_status === 'closed' && fw.source) {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'source_status "closed" contradicts having a source URL; use "patcher-only" or "binary-only"',
      });
    }
    if (!fw.source && !fw.homepage) {
      ctx.addIssue({
        code: 'custom',
        path: ['homepage'],
        message: 'every entry needs at least one of source or homepage',
      });
    }
    if (fw.videos.length && !fw.video) {
      ctx.addIssue({
        code: 'custom',
        path: ['videos'],
        message: 'videos needs a video: move the newest one to `video`',
      });
    }
    const videoIds = new Map<string, string>();
    const allVideos = [
      ...(fw.video ? [{ path: ['video'] as (string | number)[], v: fw.video }] : []),
      ...fw.videos.map((v, i) => ({ path: ['videos', i], v })),
    ];
    for (const { path, v } of allVideos) {
      const id = youtubeId(v.url);
      if (!id) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'url'],
          message: 'video url must be a YouTube watch, youtu.be, shorts or live link',
        });
        continue;
      }
      const first = videoIds.get(id);
      if (first) {
        ctx.addIssue({ code: 'custom', path: [...path, 'url'], message: `same YouTube video as ${first}` });
      } else {
        videoIds.set(id, path.join('.'));
      }
    }
    if (fw.image && !fw.image.url.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['image', 'url'], message: 'image url must be https' });
    }
    const also = new Set<string>();
    fw.also_devices.forEach((d, i) => {
      if (also.has(d)) {
        ctx.addIssue({ code: 'custom', path: ['also_devices', i], message: `"${d}" is listed more than once` });
      }
      also.add(d);
    });
    const seen = new Set<string>();
    fw.versions.forEach((v, i) => {
      if (seen.has(v.version)) {
        ctx.addIssue({
          code: 'custom',
          path: ['versions', i, 'version'],
          message: `duplicate version "${v.version}"`,
        });
      }
      seen.add(v.version);
    });
  });
}

export type Category = (typeof CATEGORIES)[number];
export type Status = (typeof STATUSES)[number];
export type SourceStatus = (typeof SOURCE_STATUSES)[number];
export type Distribution = (typeof DISTRIBUTIONS)[number];
export type License = (typeof LICENSES)[number];
export type Kind = (typeof KINDS)[number];
export type DeviceData = z.infer<typeof deviceSchema>;
export type DeviceImage = z.infer<typeof imageSchema>;
export type ManufacturerData = z.infer<typeof manufacturerSchema>;
export type ManufacturerLogo = z.infer<typeof logoSchema>;
export type FirmwareData = z.infer<typeof firmwareBaseSchema>;
export type Version = z.infer<typeof versionSchema>;
export type FirmwareVideo = z.infer<typeof videoSchema>;
export type FirmwareImage = z.infer<typeof firmwareImageSchema>;
