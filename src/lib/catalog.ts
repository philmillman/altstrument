/**
 * Catalog helpers. Pages stay thin: all grouping, sorting and URL logic is here.
 */
import { getCollection, type CollectionEntry } from 'astro:content';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  STATUSES,
  type Category,
  type ManufacturerLogo,
  type Status,
  type Version,
} from '@/content/schema';

type DeviceEntry = CollectionEntry<'devices'>;
type FirmwareEntry = CollectionEntry<'firmwares'>;
type ManufacturerEntry = CollectionEntry<'manufacturers'>;

export interface FirmwareItem {
  /** "<device-slug>/<fw-slug>" */
  id: string;
  slug: string;
  /** The primary device: the entry's directory, where its page lives. */
  deviceId: string;
  /** Every device the entry targets: the primary, then its `also_devices`. */
  deviceIds: string[];
  url: string;
  data: FirmwareEntry['data'];
  /** Newest first, undated last. */
  versions: Version[];
  /** Position in the listing device's `pinned` list; pinned entries sort first. */
  pin?: number;
  /** Quality index (src/lib/quality.ts). */
  quality: Quality;
}

export interface DeviceItem {
  id: string;
  url: string;
  data: DeviceEntry['data'];
  manufacturerSlug: string;
  /**
   * The manufacturer's logo, resolved only when the device has no `image`
   * (the fallback visual). Pages and cards read this instead of re-querying.
   */
  logo?: ManufacturerLogo;
  /**
   * Sorted: kind firmware before tool, then pinned, then by status, then name. Excludes
   * entries hidden by the device's `hide_stale_after_years`, so every list,
   * count, feed and search index built from it leaves them out. Includes entries
   * from other directories whose `also_devices` lists this device (their
   * `deviceId` is not this device's id); site-wide totals dedupe them by `id`.
   */
  firmwares: FirmwareItem[];
  /** A device-level quality score (shared repo or hand-set), unless the device hides quality. */
  quality?: DeviceQuality;
  /** Without a device-level score: an aggregate of the listed entries' shown scores. */
  aggregate?: DeviceAggregate;
  /** Entries hidden as stale (same sort). They still get their own page. */
  hiddenFirmwares: FirmwareItem[];
}

export interface Manufacturer {
  slug: string;
  name: string;
  url: string;
  website?: string;
  /** From the manufacturers collection; shown on the manufacturer page whether or not devices have images. */
  logo?: ManufacturerLogo;
  devices: DeviceItem[];
  firmwareCount: number;
}

export interface CategoryGroup {
  category: Category;
  label: string;
  devices: DeviceItem[];
}

export interface RecentVersion {
  date: Date;
  version: Version;
  firmware: FirmwareItem;
  /** The firmware's primary device. */
  device: DeviceItem;
  /** Every device the firmware targets, primary first. */
  devices: DeviceItem[];
  /** Older versions folded into this row by `collapseRuns`, newest first. */
  more?: Version[];
}

import { isStale } from './stale';
import { aggregateQuality, computeQuality, type DeviceAggregate, type DeviceQuality, type Quality } from './quality';
import { loadMetrics } from './repo-metrics';

/** kebab-case of a name; used for manufacturer slugs everywhere. */
import { slugify } from './slug';
export { slugify };

const STATUS_ORDER: Status[] = ['active', 'maintained', 'dormant', 'announced', 'unknown', 'archived'];

export function statusRank(status: Status): number {
  const i = STATUS_ORDER.indexOf(status);
  return i === -1 ? STATUSES.length : i;
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export function compareText(a: string, b: string): number {
  return collator.compare(a, b);
}

/** Pinned entries first, in pinned-list order; 0 when neither or both are unpinned. */
function comparePins(a: FirmwareItem, b: FirmwareItem): number {
  return (a.pin ?? Infinity) - (b.pin ?? Infinity) || 0;
}

/** The catalog's base order: kind firmware before tool, then pinned, then by quality (see compareFirmwaresByQuality). */
export function compareFirmwares(a: FirmwareItem, b: FirmwareItem): number {
  const kind = Number(a.data.kind === 'tool') - Number(b.data.kind === 'tool');
  return kind || compareFirmwaresByQuality(a, b);
}

/** Pinned first, then newest dated version, undated last, then name. Matches "Recently updated" in FirmwareFilter. */
export function compareFirmwaresByUpdated(a: FirmwareItem, b: FirmwareItem): number {
  const pin = comparePins(a, b);
  if (pin) return pin;
  const au = isoDate(firmwareUpdated(a)) ?? '';
  const bu = isoDate(firmwareUpdated(b)) ?? '';
  if (au !== bu) return !au ? 1 : !bu ? -1 : au < bu ? 1 : -1;
  return compareText(a.data.name, b.data.name);
}

/**
 * Pinned first, then higher quality score; ties (entries sharing a device-level
 * score) by newest dated version, then name. Matches "Quality" in FirmwareFilter.
 */
export function compareFirmwaresByQuality(a: FirmwareItem, b: FirmwareItem): number {
  return comparePins(a, b) || b.quality.score - a.quality.score || compareFirmwaresByUpdated(a, b);
}

export function compareDevices(a: DeviceItem, b: DeviceItem): number {
  return compareText(a.data.manufacturer, b.data.manufacturer) || compareText(a.data.name, b.data.name);
}

/** Newest date first; undated versions last in their original order. */
export function sortVersions(versions: Version[]): Version[] {
  return [...versions].sort((a, b) => {
    if (a.date && b.date) return b.date.getTime() - a.date.getTime();
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
}

export function latestVersion(fw: FirmwareItem): Version | undefined {
  return fw.versions[0];
}

export function manufacturerUrl(name: string): string {
  return `/manufacturers/${slugify(name)}`;
}

/** All manufacturer entries keyed by id (= slugify(name)). */
export async function getManufacturerEntries(): Promise<Map<string, ManufacturerEntry>> {
  const entries = await getCollection('manufacturers');
  return new Map(entries.map((e) => [e.id, e]));
}

/** Manufacturer entry for a device's `manufacturer` string, keyed by slugify(name). */
export async function manufacturerFor(name: string): Promise<{ id: string; data: ManufacturerEntry['data'] } | undefined> {
  const entry = (await getManufacturerEntries()).get(slugify(name));
  return entry && { id: entry.id, data: entry.data };
}

export async function getDevicesWithFirmwares(): Promise<DeviceItem[]> {
  const [devices, firmwares, manufacturers] = await Promise.all([
    getCollection('devices'),
    getCollection('firmwares'),
    getManufacturerEntries(),
  ]);

  const pinnedBy = new Map(devices.map((d) => [d.id, d.data.pinned]));
  // Loader-generated entries skip schema defaults; fill the ones read below.
  for (const fw of firmwares) fw.data.community ??= [];
  for (const fw of firmwares) fw.data.tags ??= [];
  const quality = computeQuality(
    firmwares.map((fw) => ({ ...fw.data, id: fw.id, deviceIds: [fw.data.device.id, ...fw.data.also_devices] })),
    loadMetrics(),
    Object.fromEntries(
      devices.map((d) => [d.id, { manufacturer: d.data.manufacturer, community: d.data.links.community, quality: d.data.quality }]),
    ),
  );
  const byDevice = new Map<string, FirmwareItem[]>();
  for (const fw of firmwares) {
    const deviceId = fw.data.device.id;
    const slug = fw.id.split('/').pop() as string;
    const deviceIds = [deviceId, ...fw.data.also_devices];
    const item: FirmwareItem = {
      id: fw.id,
      slug,
      deviceId,
      deviceIds,
      url: `/firmware/${deviceId}/${slug}`,
      data: fw.data,
      versions: sortVersions(fw.data.versions),
      quality: quality.entries.get(fw.id)!,
    };
    // One copy per targeted device, each with that device's pin.
    for (const id of deviceIds) {
      if (!pinnedBy.has(id)) throw new Error(`${fw.id}: also_devices lists unknown device "${id}"`);
      const pin = pinnedBy.get(id)?.indexOf(slug) ?? -1;
      const list = byDevice.get(id) ?? [];
      list.push(pin >= 0 ? { ...item, pin } : item);
      byDevice.set(id, list);
    }
  }

  return devices
    .map((d): DeviceItem => {
      const manufacturerSlug = slugify(d.data.manufacturer);
      const logo = d.data.image ? undefined : manufacturers.get(manufacturerSlug)?.data.logo;
      const all = (byDevice.get(d.id) ?? []).sort(compareFirmwares);
      // Pinned entries are never hidden as stale.
      const stale = (f: FirmwareItem) => f.pin === undefined && isStale(f.data, d.data.hide_stale_after_years);
      return {
        id: d.id,
        url: `/devices/${d.id}`,
        data: d.data,
        manufacturerSlug,
        ...(logo ? { logo } : {}),
        ...(quality.devices.has(d.id) ? { quality: quality.devices.get(d.id) } : {}),
        ...(() => {
          if (quality.devices.has(d.id) || d.data.quality?.hide) return {};
          const shown = all.filter((f) => !stale(f) && !f.quality.hidden).map((f) => ({ id: f.id, score: f.quality.score, rating: f.quality.rating }));
          const aggregate = aggregateQuality(shown);
          return aggregate ? { aggregate } : {};
        })(),
        firmwares: all.filter((f) => !stale(f)),
        hiddenFirmwares: all.filter(stale),
      };
    })
    .sort(compareDevices);
}

export function firmwaresForDevice(devices: DeviceItem[], deviceId: string): FirmwareItem[] {
  return devices.find((d) => d.id === deviceId)?.firmwares ?? [];
}

export function groupByCategory(devices: DeviceItem[]): CategoryGroup[] {
  return CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    devices: devices.filter((d) => d.data.category === category).sort(compareDevices),
  })).filter((g) => g.devices.length > 0);
}

export function groupByManufacturer(
  devices: DeviceItem[],
  manufacturers: Map<string, ManufacturerEntry> = new Map(),
): Manufacturer[] {
  const map = new Map<string, Manufacturer>();
  for (const d of devices) {
    let m = map.get(d.manufacturerSlug);
    if (!m) {
      m = {
        slug: d.manufacturerSlug,
        name: d.data.manufacturer,
        url: `/manufacturers/${d.manufacturerSlug}`,
        website: manufacturers.get(d.manufacturerSlug)?.data.website,
        logo: manufacturers.get(d.manufacturerSlug)?.data.logo,
        devices: [],
        firmwareCount: 0,
      };
      map.set(d.manufacturerSlug, m);
    }
    m.devices.push(d);
  }
  return [...map.values()]
    .map((m) => ({
      ...m,
      devices: m.devices.sort((a, b) => compareText(a.data.name, b.data.name)),
      firmwareCount: uniqueFirmwares(m.devices).length,
    }))
    .sort((a, b) => compareText(a.name, b.name));
}

/** A firmware's newest dated version, if any. */
export function firmwareUpdated(fw: FirmwareItem): Date | undefined {
  return fw.versions.find((v) => v.date)?.date;
}

/** Newest dated version across a device's firmwares, if any. */
export function latestUpdate(device: DeviceItem): Date | undefined {
  let best: Date | undefined;
  for (const fw of device.firmwares) {
    const d = firmwareUpdated(fw);
    if (d && (!best || d.getTime() > best.getTime())) best = d;
  }
  return best;
}

/** Newest update across several devices, if any. */
export function latestUpdateOf(devices: DeviceItem[]): Date | undefined {
  let best: Date | undefined;
  for (const d of devices) {
    const u = latestUpdate(d);
    if (u && (!best || u.getTime() > best.getTime())) best = u;
  }
  return best;
}

/** Listed entries across devices, each once even when it targets several of them. */
export function uniqueFirmwares(devices: DeviceItem[]): FirmwareItem[] {
  const byId = new Map<string, FirmwareItem>();
  for (const d of devices) for (const f of d.firmwares) if (!byId.has(f.id)) byId.set(f.id, f);
  return [...byId.values()];
}

export function firmwareTotal(devices: DeviceItem[]): number {
  return uniqueFirmwares(devices).length;
}

/** Most firmware entries first; ties by name. Matches the "popularity" sort on the index. */
export function compareByPopularity(a: DeviceItem, b: DeviceItem): number {
  return b.firmwares.length - a.firmwares.length || compareText(a.data.name, b.data.name);
}

/**
 * The most recent dated versions across all firmwares, newest first.
 * `onePerFirmware` keeps only each firmware's newest dated version, so one
 * busy release day can't fill a short list. `collapseRuns` folds back-to-back
 * versions of the same firmware (a batch of RCs and a release) into the first
 * row's `more`; `limit` then counts rows, not versions. An entry that targets
 * several devices is listed once, under its primary device. `kind` limits the
 * list to firmware or to tools.
 */
export function recentVersions(
  devices: DeviceItem[],
  limit = 50,
  {
    onePerFirmware = false,
    collapseRuns = false,
    kind,
  }: { onePerFirmware?: boolean; collapseRuns?: boolean; kind?: 'firmware' | 'tool' } = {},
): RecentVersion[] {
  const all: (RecentVersion & { order: number })[] = [];
  const deviceById = new Map(devices.map((d) => [d.id, d]));
  for (const device of devices) {
    for (const firmware of device.firmwares) {
      if (firmware.deviceId !== device.id) continue;
      if (kind && firmware.data.kind !== kind) continue;
      const targets = firmware.deviceIds.map((id) => deviceById.get(id)).filter((d): d is DeviceItem => Boolean(d));
      // versions are sorted newest first, undated last
      for (const [order, version] of firmware.versions.entries()) {
        if (!version.date) continue;
        all.push({ date: version.date, version, firmware, device, devices: targets, order });
        if (onePerFirmware) break;
      }
    }
  }
  all.sort(
    (a, b) =>
      b.date.getTime() - a.date.getTime() ||
      compareText(a.firmware.data.name, b.firmware.data.name) ||
      // Same-day versions of one firmware keep their authored order.
      (a.firmware === b.firmware ? a.order - b.order : compareText(a.version.version, b.version.version)),
  );
  const rows: RecentVersion[] = [];
  for (const { order: _, ...row } of all) {
    const prev = rows.at(-1);
    if (collapseRuns && prev?.firmware === row.firmware) {
      (prev.more ??= []).push(row.version);
      continue;
    }
    if (rows.length === limit) break;
    rows.push(row);
  }
  return rows;
}

/** The devices most recently added to the catalog, newest first. */
export function recentDevices(devices: DeviceItem[], limit: number): DeviceItem[] {
  return [...devices]
    .sort((a, b) => b.data.added.getTime() - a.data.added.getTime() || compareText(a.data.name, b.data.name))
    .slice(0, limit);
}

export function siteStats(devices: DeviceItem[]) {
  const entries = uniqueFirmwares(devices);
  return {
    devices: devices.length,
    // Counted by kind: host-side tools (editors, flashers, SDKs) are not firmwares.
    // Each entry counts once, however many devices it targets.
    firmwares: entries.filter((f) => f.data.kind === 'firmware').length,
    tools: entries.filter((f) => f.data.kind === 'tool').length,
    manufacturers: new Set(devices.map((d) => d.manufacturerSlug)).size,
  };
}

/** YYYY-MM-DD (UTC), the form dates are authored in. */
export function isoDate(date?: Date): string | undefined {
  return date ? date.toISOString().slice(0, 10) : undefined;
}

export function versionAnchor(version: string): string {
  return `v-${slugify(version) || 'x'}`;
}

/**
 * GitHub's editor for a raw.githubusercontent.com file URL (how synced entries record
 * generated_from). Other URLs are returned unchanged.
 */
export function githubEditUrl(url: string): string {
  const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  return m ? `https://github.com/${m[1]}/${m[2]}/edit/${m[3]}/${m[4]}` : url;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const listFormat = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** "A", "A and B", "A, B and C" (no serial comma, matching the site's prose). */
export function listNames(names: string[]): string {
  return listFormat.format(names).replace(/, and /, ' and ');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Split free text into paragraphs on blank lines. */
export function paragraphs(text?: string): string[] {
  return (text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}
