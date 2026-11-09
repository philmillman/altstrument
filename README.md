<p align="center">
  <a href="https://altstrument.org">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
      <img src=".github/assets/logo-light.svg" alt="altstrument logo: a chip with ALT on it" width="130" height="110">
    </picture>
  </a>
</p>

<h1 align="center">altstrument</h1>

<p align="center">Alternative firmware and tools for music hardware. <a href="https://altstrument.org"><strong>altstrument.org</strong></a></p>

<p align="center">
  <a href="https://github.com/philmillman/altstrument/actions/workflows/ci.yml"><img src="https://github.com/philmillman/altstrument/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://altstrument.org"><img src="https://img.shields.io/website?url=https%3A%2F%2Faltstrument.org&label=altstrument.org" alt="Site status"></a>
  <a href="https://github.com/philmillman/altstrument/commits/main"><img src="https://img.shields.io/github/last-commit/philmillman/altstrument" alt="Last commit"></a>
  <a href="https://github.com/philmillman/altstrument/issues"><img src="https://img.shields.io/github/issues/philmillman/altstrument" alt="Open issues"></a>
  <br>
  <a href="https://altstrument.org"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Faltstrument.org%2Fapi%2Fstats.json&query=%24.devices&label=devices&color=0a6262" alt="Devices in the catalog"></a>
  <a href="https://altstrument.org/recent"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Faltstrument.org%2Fapi%2Fstats.json&query=%24.firmwares&label=firmwares&color=0a6262" alt="Firmwares in the catalog"></a>
  <a href="https://altstrument.org"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Faltstrument.org%2Fapi%2Fstats.json&query=%24.tools&label=tools&color=0a6262" alt="Tools in the catalog"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/code-MIT-blue" alt="Code license: MIT"></a>
  <a href="LICENSE-DATA"><img src="https://img.shields.io/badge/data-CC--BY--4.0-blue" alt="Data license: CC-BY-4.0"></a>
</p>

altstrument is a read-only directory of custom firmware and tools for music hardware, including grooveboxes, synths, samplers, controllers, pedals, Eurorack modules and vintage gear. Each device has a page listing the firmware built for it, and each firmware entry records its authors, a source or homepage link, its license, version history and status. The site links to where firmware lives. It does not host firmware files.

## What is recorded

For each firmware:

- name, kind (firmware or host-side tool), and a one-sentence summary
- authors, with optional profile links
- source repository and/or homepage
- source status (open, patcher-only, binary-only, closed) and license, with license notes where needed
- distribution method and any stock firmware it requires
- install notes and a brick-risk flag
- version history, newest first
- maintenance status (active, maintained, dormant, archived, announced, unknown)

## Scope

Firmware that replaces or modifies what runs on a device, and host-side tools that support it (editors, flashers, emulators, SDKs). Devices are listed even when no custom firmware exists, with a note saying why.

Game consoles and similar handhelds count as music hardware when music software runs on them: trackers, sequencers and synths such as LSDJ on the Game Boy or LittleGPTracker on the PSP and retro Linux handhelds. Desktop computers and single-board computers are not in scope.

## Policy

- Entries link to sources. Binaries are never hosted in this repository or on this site.
- Links to redistributed manufacturer firmware are not accepted, unless the manufacturer licenses that exact file for redistribution (for example, M-VAVE's FM-1 V15 image, which `m-vave/fm1_open` publishes under Apache-2.0). Firmware bundled in the hardware manufacturer's own repository or tool is fine; anyone else's copy of it is not.
- Flashing firmware is at your own risk and may void your warranty. Entries flagged `brick_risk` carry a documented risk of bricking the device; read their install notes before flashing.

## Repository layout

```
src/
  content/
    devices/                  one YAML file per device
    firmwares/
      <device-slug>/          one directory per device
        <firmware-slug>.yaml  one YAML file per firmware
    schema.ts                 Zod schemas and allowed values (the field reference)
  content.config.ts           Astro content collections
  data/                       GitHub metrics snapshot for quality scores
  loaders/                    content loaders for entries fetched at build time
  pages/                      Astro pages and endpoints (/api/*.json, /feed.xml, /robots.txt, /.well-known/api-catalog)
public/                       favicons, device images, and Cloudflare _headers (Link headers) and _redirects
scripts/
  validate.ts                 catalog validator (runs before build and in CI)
  build-icons.ts              rasterizes the favicon (`pnpm icons`)
  metrics/                    GitHub metrics fetch, report and based_on proposals
.github/
  ISSUE_TEMPLATE/             issue forms: bug report, new entry, entry update
  workflows/ci.yml            validate, type check and build on every push and PR
.claude/skills/discover/      /discover skill: gather script, config and prompt
```

## Local development

Requires Node 22 (the version CI uses) and the pnpm version pinned in `package.json`.

```sh
pnpm install
pnpm dev        # local dev server
pnpm validate   # check every catalog YAML file against the schema
pnpm check      # Astro type check
pnpm build      # validates, then builds the static site
pnpm preview    # serve the built site
```

Building fetches the Music Thing Workshop Computer card entries from the upstream repository (see CONTRIBUTING.md, "Entries fetched at build time"). Set `ALTSTRUMENT_SKIP_REMOTE=1` to build offline from the cached data store.

Builds need `SITE_URL` set to the public base URL the site is deployed to (for example `SITE_URL=https://altstrument.org pnpm build`). It makes canonical, social-image and RSS feed links absolute; the RSS feed refuses to build without it. `pnpm dev` doesn't need it and uses the local server's address.

## Deployment

The site is a static build served by Cloudflare Workers at [altstrument.org](https://altstrument.org). Workers Builds runs `pnpm run build` on every push to `main`, then `wrangler deploy` uploads `dist/` as static assets (see `wrangler.jsonc`). `SITE_URL` is set in the Workers Builds environment.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a device or firmware, the field reference, and the pull request checklist.

Not writing YAML? [Open an issue](https://github.com/philmillman/altstrument/issues/new/choose) to suggest a new device or firmware, request an update to an existing entry, or report a bug on the site.

To look for firmware and devices not yet in the catalog, run the `/discover` skill in Claude Code (see CONTRIBUTING.md, "Finding new entries").

## Licensing

- Code (including `src/` and `scripts/`) is MIT. See [LICENSE](LICENSE).
- Catalog data (the YAML files under `src/content/devices` and `src/content/firmwares`) is CC-BY-4.0. See [LICENSE-DATA](LICENSE-DATA).

Each firmware's own code is governed by the license recorded in its entry, not by this repository's licenses.

## Prior art and thanks

- [Lapin/awesome-music-gear-firmware](https://github.com/Lapin/awesome-music-gear-firmware)
- [aroum/fm1-custom-fw](https://github.com/aroum/fm1-custom-fw)
- [Maxhodges/noise-engineering-firmware-index](https://github.com/Maxhodges/noise-engineering-firmware-index)
- [Mutable Instruments third-party firmware](https://pichenettes.github.io/mutable-instruments-documentation/third_party_firmware/)
