---
name: garden
description: Clean up existing altstrument catalog entries without adding new ones. Finds entries with the wrong kind (firmware vs tool), duplicate entries and devices, and missing crosslinks (related devices, based_on, also_devices), applies the clear fixes and flags the rest for the maintainer. Run only when the maintainer asks for gardening or cleanup.
argument-hint: "[device slug, or a check id such as kind-suspect]"
---

# /garden

You are tidying a hand-maintained catalog. This skill only reviews entries that already exist. It never adds a firmware, tool or device. New entries are `/discover`'s job.

The catalog's rules live in `README.md` (Scope, Policy) and `CONTRIBUTING.md` (templates, field values, "One project, several devices", rules of evidence). Read both before editing anything. They win over anything in this file.

This skill runs only on demand, when the maintainer invokes it in an interactive session. It is never scheduled and never run headless. `/discover` runs a narrow pass of the same checks at the end of every run (`pnpm garden:scan --changed`, its section 5), limited to the files that run changed. That pass never moves the cursor. The slice review below happens only here. You write files and run the validator. You never commit, push, open PRs, stage changes or stash. The maintainer reviews the working tree.

Each invocation does two things:
- a cheap scripted scan of the whole catalog;
- a careful review of a slice of device directories.

The slice moves forward with every invocation (`cursor` in `config.yaml`), so repeated invocations cover the whole catalog over time.

## 1. Sync and scan

First bring the branch up to date with `main`. In a worktree, `git fetch` and `git merge --ff-only origin/main`. A stale branch reviews entries that have already changed upstream.

Then run the scan from the repository root:

```sh
pnpm garden:scan
```

- `$ARGUMENTS` is a device slug: run `pnpm garden:scan --device <slug>`, which makes that device the whole slice. Do not advance `cursor` afterwards.
- `$ARGUMENTS` is a check id (see the table below): run the plain scan and work only on that check, across the whole catalog. Do not advance `cursor`.
- `--no-based-on` skips the `based_on` proposer when you only need a quick look.
- `--changed [--base <ref>]` is what `/discover` uses. The slice becomes the devices whose catalog files differ from `<ref>` (default `HEAD`, untracked files included), and only findings that touch those files are kept. It never moves `cursor`.

The scan prints a markdown report and writes `garden-findings.json`. Every finding has a `check`, a `key`, the `files` involved, a `confidence` of `clear` or `suspect`, and `inSlice`. Findings whose `check` and `key` match `accepted` in `.claude/skills/garden/config.yaml` are already dropped.

| Check | Confidence | What it means |
|---|---|---|
| `related-asymmetric` | clear or suspect | Device A lists B in `related`, but B does not list A. Clear when both have one maker or share a firmware entry; otherwise a suspect |
| `related-from-also-devices` | clear or suspect | An entry spans two devices that do not link each other. Clear only when a firmware build spans two devices of one maker; cross-brand tools (multi-synth editors) are suspects and usually a `keep` |
| `kind-pseudo-device` | clear | A `firmware` entry sits under a `*-tools` pseudo-device |
| `based-on-proposal` | clear or suspect | The prose says "fork of" or "port of" another catalog entry, but `based_on` is not set |
| `duplicate-source` | clear or suspect | Several files share one source repo. The detail says `merge-candidate` or `separate-port?` |
| `kind-suspect` | suspect | Tags or prose suggest the other kind |
| `duplicate-homepage`, `duplicate-name` | suspect | Possible copies under another name or repo |
| `duplicate-device` | suspect | Two device files from one maker with the same name |
| `related-from-based-on`, `related-same-platform`, `related-variant` | suspect | Devices that probably should link each other: cross-device forks, one maker's devices on one platform, model variants (mkII, XL, Pro, +) |
| `also-devices-candidate` | suspect | The summary names another device that the entry may also run on |

## 2. Apply the clear catalog-wide fixes

Do these yourself across the whole catalog, not only the slice. `clear` means the scan's mechanical test passed, not that the edit is right. Glance at each pair before editing, so that a bad forward link is not mirrored.

- **`related-asymmetric`**: add the missing reverse slug to the other device's `related` list. Keep the list's existing style (block list, one slug per line) and order: append at the end unless the list is clearly alphabetical. A device with `related: []` becomes a block list. `related` means the devices share firmware or hardware (schema comment). If a forward link is only a "similar product" link, don't mirror it; list it under open questions as a link to remove.
- **`related-asymmetric`, suspect rows** (different makers, no shared firmware): mirror the link when both devices are built on the same hardware, such as boards on one Daisy Seed or Daisy Patch SM, or a clone of the original circuit. Leave ecosystem or "similar product" links (an i2c peer, a rival groovebox) for open questions, so the maintainer can decide whether the forward link should stay.
- **`related-from-also-devices`, clear rows**: add both directions.
- **`based-on-proposal`, clear rows**:
  1. Run `npx tsx scripts/metrics/propose-based-on.ts --out <scratchpad>/based-on`.
  2. Read the `confident` rows in `<scratchpad>/based-on/based-on-proposals.json`. Delete any row whose proposal the entry's prose does not support, for example a "port of X" where X names a different project than the proposed ref.
  3. Run the same command with `--apply`. It inserts one `based_on:` line per row and never re-serialises the YAML.
- **`kind-pseudo-device`**: set `kind: tool` (see the kind edits in section 3).

Edit YAML as text: change only the lines involved and never round-trip a file through a YAML serializer. Comments, quoting and folded strings must survive.

## 3. Review the slice

The slice is listed at the top of the scan report: about 45 device directories. For each one, review every entry in it, not only the flagged ones. The scan's suspects are hints, not a checklist.

With more than about 20 entries, batch them about 20 at a time by device directory to parallel agents (Sonnet). Each agent:
- owns its device directories and edits only files in them;
- gets this section and the relevant findings from `garden-findings.json`;
- edits only fixes it is sure of, inside its own directories: `kind` changes, plus `also_devices` additions backed by the project's own words that the same build runs on both devices;
- never edits for an `unclear` verdict;
- reports every other verdict to you without editing, including merges, `related` changes and `based_on`.

Agents never edit `config.yaml`, device files outside their slice, or `public/_redirects`. Each agent reports one line per finding: `file | check | verdict (fixed / keep / merge / unclear) | evidence URL or quoted phrase`.

### Kind

The question is where the entry's primary deliverable runs.

Treat `kind-suspect` lines as weak hints. The signal lists in `config.yaml` are deliberately broad, and most hits are real firmware whose prose mentions an editor or a toolchain. When one phrase keeps producing false hits, tune `tool_signals` or `firmware_signals`.

- **`firmware`**: it runs on the device. This covers:
  - OS replacements and patches to the stock OS;
  - on-device apps, modules, patches and algorithms (Schwung modules, Organelle patches, Disting algorithms, norns scripts);
  - bootloaders and firmware launchers that live on the device;
  - on-device frameworks the user installs.

  A firmware that ships a companion editor or web installer stays `firmware`.
- **`tool`**: it runs on a computer, phone or browser and supports the device. This covers:
  - editors, librarians and patch managers;
  - flashers and updaters;
  - emulators and simulators;
  - SDKs, toolchains and libraries for building firmware;
  - converters;
  - reverse-engineering kits and documentation.

  An updater that flashes the manufacturer's own image is a `tool`.
- **Patchers** (freakpatch, superfreaker) produce a modified stock image, so they are `firmware`, even though they run on a computer. The updater rule above covers only tools that flash the unmodified manufacturer image.
- **Accessory firmware** runs on a cartridge, interface board or adapter made for the device (hobbychop-mds, Arduinoboy), not on the device itself. Keep the current kind and mark it `unclear` for the maintainer to settle once. Then record the precedent here.
- **On-device developer libraries** (schwung-spi) load on the device but are only useful for building other modules. Keep the current kind and mark them `unclear`.
- **Host modules are firmware**: a module for an on-device host (Schwung on Move, Push Hack on Push 3 Standalone, Open MPC plugins) is `firmware`, even when its summary calls it a "tool module", which is Schwung's menu category, or its tags say `editor`, `sdk` or `vst`.
- **Modules for a host-side app are tools**: modules for an app that runs on a computer (the Push Tethered App) are `tool`.
- **Loaders and boot hooks are firmware**: boot scripts, SD-card autorun kits and LD_PRELOAD libraries that run on the device are `firmware` (MPC-LiveXplore, mpc-sample-root-ssh). So is a reverse-engineering kit that ships a runnable patch or mode. A kit of notes and host-side scripts with nothing that runs on the device is a `tool`.
- **Scripts that drive the device are tools**: scripts that run on a computer and act on the device over the network or USB (move-network) are `tool`, like flashers.
- **Mixed repositories**: classify by what the summary leads with. When the firmware and the host tool are equal halves, keep the current kind and mark the entry `unclear` with one line on why.
- **Unsure**: read the project README. Save long READMEs to a file and read them in pieces.

Kind edits:
- To `tool`: add `kind: tool` on the line after `name:`, which is the template's field order.
- To `firmware`: delete the `kind:` line, since `firmware` is the default and most entries omit it. An existing explicit `kind: firmware` line on a correct entry is harmless, so leave it alone.
- If the summary or tags now contradict the kind (a "firmware" tag on a tool, "replaces the OS" on an editor), fix those words too. Tags should stay ones neighbouring entries already use.

### Duplicates and ports

For each `duplicate-*` group that touches the slice, decide with CONTRIBUTING's "One project, several devices":
- **Same build and same text on every device**: merge into one entry with `also_devices`.
- **Different builds, release lines, `requires_stock`, install steps or a device-specific summary**: keep the files separate. Propose an `accepted` item for the group in the report, with the reason.
- **Two names for one project** (renamed repo, mirror, re-upload): merge. Check the repos themselves, because a shared owner is not proof.
- **A fork that differs**: keep it. Set `based_on` if it is missing and the fork is not a GitHub fork.

Agents report merges as `merge` verdicts. You do the merging (section 4).

### Crosslinks

- **`related-from-based-on`, `related-same-platform`**: add both directions when the devices really share firmware or hardware. A family, a shared platform with ported firmware, or the same OS on two sizes all count. A shared MCU alone is not enough.
- **`also-devices-candidate`**:
  - Add the device to `also_devices` only when the project's own README or releases say the same build runs there.
  - A port with its own build is a separate entry, and adding it is `/discover`'s job: list it under open questions.
  - A summary that merely compares with another device is a `keep`.
  - Look beyond the scan rows. It matches full device names only, so it misses short forms like "MPC and Force". Devices that share one OS (MPC Live and Force, sizes of one controller) are worth checking entry by entry.
  - When one entry already ships separate images for each device from one repo and one release (MPC-Force-SSH-Firmwares), listing the second device in `also_devices` is right. CONTRIBUTING wants a separate file only when the text or install steps differ.
  - A device named in a summary that has no device file is a `/discover` lead, not a gardening fix.
  - Write `also_devices` in the style of the neighbouring files in the same directory (inline `[a, b]` or a block list), right after `device:`.
- **`based_on` suspects** (`ambiguous` rows): set `based_on` only when the prose or README names the parent unambiguously and the entry is not a GitHub fork. The validator rejects refs that do not exist and cycles.

### Not in scope

Leave these alone; at most flag them under open questions:
- releases and versions, link rot and media, which `/discover` handles;
- licenses and prose quality;
- moving an entry to another device directory;
- device `category`.

## 4. Merges

You do these yourself, because they touch several directories.

1. **Pick the survivor.** Prefer the entry under the device the project was written for first, then the older file (`git log --diff-filter=A --format=%as -- <file>`), then the more complete one.
2. **Fold the copy in.**
   - Add the copy's device to the survivor's `also_devices`.
   - Add any `versions` the survivor lacks, keeping them newest first with no duplicates.
   - Add `community` links, and a `video`, `videos` or `image` the survivor lacks.
   - Add tags that apply to the shared build.
   - Make the summary device-neutral if it names only one device.
3. **Delete the copy** with plain `rm`, not `git rm`.
4. **Add a 301 to `public/_redirects`**: `/firmware/<copy-device>/<copy-slug> /firmware/<survivor-device>/<survivor-slug> 301`.
5. **Rewrite references** to the copy:

   ```sh
   grep -rn "<copy-device>/<copy-slug>" src/content
   grep -rn "<copy-slug>" src/content/devices/<copy-device>.yaml
   ```

   This covers `based_on` refs and `pinned` lists. A `pinned` slug on the copy's device can stay when the survivor now lists that device in `also_devices`.
6. **Never merge device files automatically.** A `duplicate-device` pair goes to open questions with the evidence, because merging moves whole directories.

## 5. Validate

```sh
ALTSTRUMENT_SKIP_REMOTE=1 pnpm validate
pnpm check
```

Fix every error. Read every warning that names a file you touched.

Then check that the working tree holds exactly what was reported:

```sh
git status --porcelain -uall
git diff --cached --stat
```

- Every changed file must appear in your own edits or an agent's report.
- Nothing may be staged. If something is, run `git restore --staged`.
- Spot-check a few agent kind edits against their evidence.

Run `pnpm garden:scan` once more. `related-asymmetric`, `related-from-also-devices` and `kind-pseudo-device` should be at 0.

## 6. Record

In `.claude/skills/garden/config.yaml`:
- **`cursor`**: set it to the scan's `nextCursor`, unless `$ARGUMENTS` narrowed the run.
- **`last_full_pass`**: set it to today's date when the scan reports `wrapped: true`.
- **`accepted`**: append items whose keep verdict precedent already settles. These are CONTRIBUTING's examples, or groups already judged the same way, such as a known separate port. Use this format:

  ```yaml
    - check: duplicate-source
      key: https://github.com/owner/repo
      reason: separate builds for the Pro and the Elite
      date: 2026-11-15
  ```

  Everything else that should stop recurring goes in the report as a proposed `accepted` item for the maintainer to approve.

## 7. Report and stop

End with a short, skimmable report:

- **Counts**: whole-catalog findings per check before and after this run, the slice reviewed (first and last device, entry count), and the new cursor.
- **Kind changes**: each file as a clickable path, `firmware → tool` or `tool → firmware`, with a one-line reason.
- **Merges**: the survivor path, the deleted path and the redirect line.
- **Crosslinks added**: `related` and `based_on` additions grouped by device, plus `also_devices` additions with their evidence link.
- **Accepted**: items appended to `accepted`, and proposed ones awaiting the maintainer.
- **Open questions**:
  - unclear kinds;
  - `duplicate-device` pairs;
  - `separate-port?` groups you could not settle;
  - ports that need their own entry, for `/discover`;
  - out-of-scope problems noticed in passing.
- **Validator**: the final summary line.

Leave the working tree uncommitted. Do not run `git add`, `git commit`, `git push`, `gh pr create` or `git stash`.
