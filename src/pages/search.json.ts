import type { APIRoute } from 'astro';
import { getDevicesWithFirmwares, getManufacturerEntries, groupByManufacturer } from '@/lib/catalog';

/**
 * Index for the site-wide search modal (src/components/SearchModal.astro), fetched the
 * first time the modal opens. Keys are short to keep the file small:
 * n name, u url, m manufacturer, c category (categories for entries), t tagline,
 * p entry count, k kind, d device names, a authors, g tags, s summary.
 * Entries hidden as stale are left out (device.firmwares excludes them).
 */
export const GET: APIRoute = async () => {
  const [devices, entries] = await Promise.all([getDevicesWithFirmwares(), getManufacturerEntries()]);
  const byId = new Map(devices.map((d) => [d.id, d]));

  const deviceList = devices.map((d) => ({
    n: d.data.name,
    u: d.url,
    m: d.data.manufacturer,
    c: d.data.category,
    ...(d.data.tagline ? { t: d.data.tagline } : {}),
    p: d.firmwares.length,
  }));

  const manufacturers = groupByManufacturer(devices, entries).map((m) => ({
    n: m.name,
    u: m.url,
    p: m.devices.length,
  }));

  // An entry that targets several devices (also_devices) is listed under each; keep one.
  const seen = new Set<string>();
  const entryList = [];
  for (const d of devices) {
    for (const f of d.firmwares) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      const targets = f.deviceIds.map((id) => byId.get(id)).filter((t) => t !== undefined);
      entryList.push({
        n: f.data.name,
        u: f.url,
        k: f.data.kind,
        d: targets.map((t) => t.data.name),
        c: [...new Set(targets.map((t) => t.data.category))],
        a: f.data.authors.map((a) => a.name),
        ...(f.data.tags.length ? { g: f.data.tags } : {}),
        s: f.data.summary,
      });
    }
  }

  return new Response(JSON.stringify({ devices: deviceList, manufacturers, entries: entryList }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
