# Contributing

Thanks for adding to the catalog. Every entry is a YAML file checked against the schema in `src/content/schema.ts` by `scripts/validate.ts`. The templates below use placeholder values that pass the schema; replace them with real ones.

Not writing YAML? [Open an issue](https://github.com/philmillman/altstrument/issues/new/choose) instead: there are forms for suggesting a new device or firmware, requesting an update to an existing entry, and reporting a bug on the site.

## Adding a device

1. Create `src/content/devices/<slug>.yaml`.
2. The slug is lowercase kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), built as `manufacturer-device`, for example `elektron-digitakt`.
3. Fill in the template below. A device with no firmware entries needs a `notes` value explaining why.

## Adding a firmware

1. Create `src/content/firmwares/<device-slug>/<firmware-slug>.yaml`. The directory must already exist as a device slug, so the device file comes first.
2. The `device` field must equal the directory name, and that device file must exist.
3. The firmware slug is lowercase kebab-case, named after the firmware (`octabam`).
4. If the same entry applies to more than one device, write one file and list the other devices in `also_devices`. See "One project, several devices" below.

## Entries fetched at build time

Some entries are not files in this repository. They are fetched from an upstream data source when the site builds, by a content loader under `src/loaders/`. Today that is every Music Thing Workshop Computer program card: the loader reads each card's `info.yaml` from the `releases/` folder of the Workshop_Computer repository and adds one entry per card to the `firmwares` collection, alongside the file-based entries. The only file under `src/content/firmwares/music-thing-workshop-computer/` is the hand-written `program-card-library.yaml`.

- Such entries carry a `generated_from` field with the URL of the upstream file they were built from, and their pages show a "Synced from" row.
- To correct one, fix the upstream `info.yaml`; the next build picks it up. There is nothing to edit here.
- To change how fields are mapped (status, license, tags), edit the loader in `src/loaders/workshop-computer.ts`.
- Builds need network access for these entries. The loader caches on the directory listing's ETag, so an unchanged upstream costs one request. Set `GITHUB_TOKEN` to raise the GitHub API rate limit, or `ALTSTRUMENT_SKIP_REMOTE=1` to build offline from the cached data store.

## Build cache

Builds reuse the previous output for OG cards and catalog pages whose inputs have not changed. The cache lives in `node_modules/.astro`, and Cloudflare's build cache and the GitHub CI cache keep it between builds. A page's cached output is invalidated by its props (`cacheKey`), by any device photo or logo its OG card shows, by changes to the route's code or to the components and packages it imports, and by changes to `astro.config.mjs` or `pnpm-lock.yaml`. A page that renders something not in its props or code, such as a file read from disk, must include that input in its cacheKey via `src/lib/cache-key.ts`. To force a full rebuild, run `rm -rf node_modules/.astro` locally, or clear the build cache in the Cloudflare dashboard under Settings → Build → Build cache. `pnpm build:timings` prints a per-phase timing report.

## Finding new entries

The repository ships a Claude Code skill, `/discover`, that looks for custom firmware projects and devices missing from the catalog. Run it in a Claude Code session opened at the repository root. It:

1. runs `pnpm discover:candidates`, which reads synth news and forum feeds, searches GitHub, and checks the catalogs listed under "Prior art" in the README, then drops anything already linked from `src/content`;
2. researches each remaining candidate against the rules in this file;
3. writes draft device and firmware YAML and runs `pnpm validate`;
4. stops without committing, so you review the files like any other change.

Feeds, search queries, keywords and the list of rejected candidates live in `.claude/skills/discover/config.yaml`. Rejected candidates are recorded under `ignore` with a reason so they are not shown again; edit that list by hand to un-reject one. `pnpm discover:candidates --help` lists the gather script's flags for running it on its own.

## Device template

```yaml
# src/content/devices/example-co-example-synth.yaml

# REQUIRED. Display name.
name: Example Synth

# REQUIRED. Manufacturer display name.
manufacturer: Example Co

# REQUIRED. One of: synth, groovebox, sampler, drum-machine, controller,
# foot-controller, pedal, eurorack, diy-platform, handheld, tools, other
# (handheld: game consoles and handhelds that run music software)
category: synth

# OPTIONAL. Up to 140 characters, plain text.
tagline: pocket FM synth

# OPTIONAL. 2 to 4 factual sentences about what the device is. Plain prose,
# blank line between paragraphs. Firmware caveats go in notes, not here.
description: >-
  Example description. Say what the device is and does, in plain factual terms.

# OPTIONAL. MCU, SoC or DSP family.
platform: ARM Cortex-M4

# OPTIONAL. Stock OS version that most mods currently target.
stock_firmware: 1.2.0

# OPTIONAL. Defaults to { community: [] }.
links:
  # OPTIONAL. Official product page.
  manufacturer: https://example.com/example-synth
  # OPTIONAL. Defaults to []. Forums, wikis, community hubs.
  community:
    - label: Example forum
      url: https://forum.example.com/

# OPTIONAL. Device-level caveats: brick risk, platform policy, "no custom
# firmware exists". Plain text, may span lines.
notes: >-
  Example note.

# OPTIONAL. Defaults to []. Slugs of other devices that share firmware or
# hardware. Each slug must have a device file.
related: []
```

## Firmware template

```yaml
# src/content/firmwares/example-co-example-synth/examplefw.yaml

# REQUIRED. Must equal the directory name (the device slug). The entry's page
# lives under this device.
device: example-co-example-synth

# OPTIONAL. Defaults to []. Other device slugs this same entry targets, when
# the build and text apply to them unchanged. Each must have a device file,
# must differ from `device`, and must not already have a file with this
# entry's name. See "One project, several devices".
also_devices: []

# REQUIRED. Display name of the firmware or tool.
name: ExampleFW

# OPTIONAL. Defaults to firmware. One of:
#   firmware  replaces or modifies what runs on the device
#   tool      host-side tool that supports the scene (editor, flasher, emulator, SDK)
kind: firmware

# REQUIRED. 1 to 280 characters, plain factual prose.
summary: Replaces the stock OS with a reworked oscillator engine and a MIDI clock sync option.

# OPTIONAL. Longer plain prose.
description: >-
  Example description. Say what the firmware changes, in plain factual terms.

# OPTIONAL. Defaults to unknown. One of:
#   active | maintained | dormant | archived | announced | unknown
status: maintained

# REQUIRED. At least one author.
authors:
  - name: Jane Doe
    # OPTIONAL. Profile or project page.
    url: https://github.com/janedoe

# REQUIRED when source_status is open. Must be absent when source_status is closed.
# Source repository or release page.
source: https://github.com/janedoe/examplefw

# REQUIRED. One of: open | patcher-only | binary-only | closed
source_status: open

# REQUIRED. An SPDX id from the list in src/content/schema.ts, or proprietary
# or unspecified. See "Choosing a license" below.
license: MIT

# OPTIONAL. Qualifier for the license, e.g. "patch/ directory excluded".
license_notes: Example qualifier.

# REQUIRED when source is absent. Otherwise optional. Primary non-repo link:
# project site, forum thread or installer page.
homepage: https://example.com/examplefw

# OPTIONAL. One of: download | browser-installer | patch-your-own | commercial | source-only
distribution: source-only

# OPTIONAL. Stock firmware version(s) this targets, if specific.
requires_stock: 1.2.0

# OPTIONAL. Install steps and warnings, plain text.
install_notes: >-
  Example install note.

# OPTIONAL. Defaults to false. Set to true when flashing has a known,
# documented risk of bricking the device.
brick_risk: false

# OPTIONAL. Defaults to []. Lowercase letters, digits and hyphens only.
tags: [oscillator, midi-clock]

# OPTIONAL. A demo video. YouTube only (watch, youtu.be, shorts or live links;
# a t= offset is honoured). Prefer a video linked from the firmware's own
# README or homepage: set first_party: true and found_via to the page that
# links it. Otherwise use a third-party demo of this firmware, with
# first_party: false. Take title and credit (the channel) from YouTube oEmbed.
# This is the main video: the page embeds it and cards use its thumbnail.
video:
  url: https://www.youtube.com/watch?v=dQw4w9WgXcQ
  title: ExampleFW 1.3 walkthrough
  credit: Example Channel
  first_party: true
  found_via: https://github.com/janedoe/examplefw/releases/tag/v1.3.0
  # OPTIONAL. The release the video shows, exactly as in versions[].
  version: 1.3.0

# OPTIONAL. Defaults to []. More videos, same fields as `video`, listed under
# it on the page. Newest first; needs `video`, which holds the newest. Use it
# for one first-party walkthrough per release, not for every demo you find.
videos:
  - url: https://www.youtube.com/watch?v=jNQXAC9IVRw
    title: ExampleFW 1.2 walkthrough
    credit: Example Channel
    first_party: true
    found_via: https://github.com/janedoe/examplefw#readme
    version: 1.2.0

# OPTIONAL. Use only when there is no video. A hotlinked screenshot or photo:
# a direct https image URL (raw.githubusercontent.com or the project's own
# site), never a github.com/.../blob/ page. Not copied into the repo.
image:
  url: https://example.com/examplefw/screenshot.png
  alt: ExampleFW main screen showing the oscillator page
  credit: Jane Doe
  # Page the image appears on.
  source_url: https://example.com/examplefw
  first_party: true

# OPTIONAL. Defaults to []. Newest first. Each version string must be unique
# within the entry.
versions:
  - version: 1.3.0
    # OPTIONAL. ISO date (YYYY-MM-DD), only when confirmed. Otherwise omit.
    date: 2026-01-31
    # OPTIONAL. Release page or commit.
    url: https://github.com/janedoe/examplefw/releases/tag/v1.3.0
    # OPTIONAL. One-line summary of the change.
    notes: Adds MIDI clock sync.
  - version: 1.2.0
    url: https://github.com/janedoe/examplefw/releases/tag/v1.2.0
```

When a release brings its own first-party video, put it in `video` and move the previous one to the top of `videos`. See `m-vave-fm-1/mutable-dreams.yaml`. The same YouTube video may appear only once per entry, whatever the URL form. `pnpm validate` warns when a video's `version` is missing from `versions[]` or when `video` and `videos` are not in the same newest-first order as `versions[]`.

`pnpm validate` checks every `video` and `videos` entry against YouTube's oEmbed endpoint and every `image` URL for an image content type. A removed or missing target (404) is an error; network trouble is only a warning. Set `ALTSTRUMENT_SKIP_REMOTE=1` to skip these checks. In a pull request, CI only checks the media of the files the PR changes, so a link that broke elsewhere in the catalog won't fail your PR; a daily run on `main` checks every link. Workshop Computer cards are fetched at build time (see above) and take their video from the upstream `info.yaml` `demo-link`, so there is no `video` to write for them.

## One project, several devices

Write a single file when the same build and the same text apply to every device, such as a browser editor for both Model:Cycles and Model:Samples, or an OS that ships unchanged on two sizes of one controller. Put the file under the device it was written for first, or the original model, and list the others in `also_devices`. The entry keeps one page under that primary device. Each device in `also_devices` lists it, links to that page and may name it in `pinned`. Site totals, the feed and the recent page count it once.

Write a separate file per device when the entries differ: different builds or release lines, a different `requires_stock`, different install steps or wiring, or a summary that says something device-specific. Parasites for Clouds and for Warps, ChoralRoot for FM-1 and for SMK-37, and the DS and 3DS NitrousTracker entries are examples. `pnpm validate` warns when two files share a `source` and a `summary`, because that usually means one entry was copied instead of shared.

When an existing copy is merged away, delete its file and add a `301` line to `public/_redirects` from its old URL to the remaining entry.

## Field values

### status

| Value        | Meaning                                                  |
|--------------|----------------------------------------------------------|
| `active`     | commits or releases within roughly the last year         |
| `maintained` | stable, infrequent updates, author still responsive      |
| `dormant`    | no activity for a long time, still usable                |
| `archived`   | explicitly archived or abandoned by the author           |
| `announced`  | publicly announced, nothing downloadable yet             |
| `unknown`    | default; use when the status cannot be determined        |

### source_status

| Value          | Meaning                                                                 |
|----------------|-------------------------------------------------------------------------|
| `open`         | full source published. Requires `source`.                               |
| `patcher-only` | patch tooling is public, the firmware changes themselves are not        |
| `binary-only`  | only compiled images are distributed                                    |
| `closed`       | nothing public. Must not have `source`.                                 |

### distribution

| Value               | Meaning                                              |
|---------------------|------------------------------------------------------|
| `download`          | prebuilt image you flash yourself                    |
| `browser-installer` | WebMIDI / WebUSB installer page                      |
| `patch-your-own`    | tool patches a stock firmware file you supply        |
| `commercial`        | paid                                                 |
| `source-only`       | you must build it yourself                           |

### kind

| Value      | Meaning                                                                    |
|------------|----------------------------------------------------------------------------|
| `firmware` | replaces or modifies what runs on the device (default)                     |
| `tool`     | host-side tool that supports the scene (editor, flasher, emulator, SDK)    |

## Choosing a license

1. Use the license in the source repository's `LICENSE` file (or the license statement on the homepage). Use the SPDX identifier that matches it exactly, for example `GPL-3.0-or-later`, not `GPL-3.0`.
2. If the license has a carve-out or exception (a directory excluded, a linking exception), record it in `license_notes`.
3. Use `proprietary` when the author reserves all rights or states custom non-open terms.
4. Use `unspecified` when there is no license file and no license statement.
5. A vague statement such as "free for personal use" is not a license. Use `proprietary` if it describes custom non-open terms, or `unspecified` if you cannot tell, and quote the statement in `license_notes`.
6. If the SPDX id you need is missing from the list, open a PR that adds it to `LICENSES` in `src/content/schema.ts`. Do not use free text.

The validator warns when `source_status` is `open` and `license` is `unspecified`.

Accepted values: `MIT`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `Apache-2.0`, `GPL-2.0-only`, `GPL-2.0-or-later`, `GPL-3.0-only`, `GPL-3.0-or-later`, `LGPL-2.1-only`, `LGPL-2.1-or-later`, `LGPL-3.0-or-later`, `AGPL-3.0-only`, `AGPL-3.0-or-later`, `MPL-2.0`, `Unlicense`, `WTFPL`, `CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0`, `CC-BY-NC-4.0`, `CC-BY-NC-SA-4.0`, `CC-BY-SA-3.0`, `CC-BY-NC-SA-3.0`, `PolyForm-Noncommercial-1.0.0`, `Elastic-2.0`, `proprietary`, `unspecified`.

## Rules of evidence

- Every link must be live when you submit. Open each one.
- Dates only when confirmed by a release page, changelog or commit. Otherwise omit the `date`.
- Versions newest first. Version strings must be unique within an entry.
- Write summaries and descriptions as plain, factual prose: what the firmware does. No marketing language or superlatives.
- Write your own summaries. Do not copy text from other catalogs or sites.

## What we do not accept

- Links to redistributed manufacturer firmware, including third-party mirrors of official OS images. The hardware manufacturer's own repository or tool may bundle or serve its own firmware; that is not redistribution. The exception is a file the manufacturer itself licenses for redistribution, such as M-VAVE's FM-1 V15 image (`FM-1_015.fwsc`, Apache-2.0 in `m-vave/fm1_open`) or its SMK-37 Pro and Elite V16 images (`sdk/firmware/` in `m-vave/smk37_open`, whose THIRD_PARTY.md permits redistribution for those devices). The copy must match the licensed file exactly; check its hash, and say in `license_notes` which licensed file it is.
- Binary files of any kind in the repository (`.bin`, `.syx`, `.hex`, firmware archives).
- Affiliate or referral links.
- Entries without a working `source` or `homepage`.
- Links that the hardware platform forbids sharing. The `notes` field on `elektron-octatrack` shows an example of a platform policy.

## Pull request checklist

- [ ] `pnpm validate` passes
- [ ] `pnpm check` passes
- [ ] `pnpm build` passes
- [ ] Every link opens
- [ ] `license` matches the source repository's license file
- [ ] Versions are newest first, with no duplicates, and dates appear only where confirmed
- [ ] No binary files are added
- [ ] A project that targets several devices with the same build is one entry with `also_devices`, not a copy per device
- [ ] One device or one firmware per PR when possible

## Licensing of contributions

By opening a pull request, you agree that your code contributions are licensed under MIT (see [LICENSE](LICENSE)) and that your data contributions under `src/content` are licensed under CC-BY-4.0 (see [LICENSE-DATA](LICENSE-DATA)).
