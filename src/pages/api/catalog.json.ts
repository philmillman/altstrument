import type { APIRoute } from 'astro';
import { getDevicesWithFirmwares, getManufacturerEntries, isoDate } from '@/lib/catalog';

export const GET: APIRoute = async ({ site }) => {
  const [devices, manufacturerEntries] = await Promise.all([getDevicesWithFirmwares(), getManufacturerEntries()]);
  const abs = (path: string) => (site ? new URL(path, site).href : path);

  const manufacturers = [...manufacturerEntries.values()]
    .map((m) => ({
      id: m.id,
      name: m.data.name,
      website: m.data.website,
      // Present only when a logo is on file; `url` is the absolute file URL.
      logo: m.data.logo ? { ...m.data.logo, url: abs(m.data.logo.src) } : undefined,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const deviceList = devices.map((d) => ({
    id: d.id,
    url: abs(d.url),
    ...d.data,
    // Present only when the device has an image (`style`: photo | line-art); `url` is the absolute file URL.
    ...(d.data.image ? { image: { ...d.data.image, url: abs(d.data.image.src) } } : {}),
    manufacturer_slug: d.manufacturerSlug,
    // An entry that targets several devices (also_devices) appears under each of
    // them with the same `id` and `url`; dedupe by `id` to count entries.
    firmwares: d.firmwares.map((f) => {
      const { device: _device, versions: _versions, ...rest } = f.data;
      return {
        id: f.id,
        slug: f.slug,
        url: abs(f.url),
        ...rest,
        versions: f.versions.map((v) => ({ ...v, date: isoDate(v.date) })),
        // Methodology: /about/quality. Only the public rating; the numeric score is internal.
        // Replaces the entry's own `quality` settings from `rest`. null: not enough data.
        quality: f.quality.hidden ? undefined : { rating: f.quality.rating ?? null },
      };
    }),
  }));

  return new Response(JSON.stringify({ manufacturers, devices: deviceList }, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
