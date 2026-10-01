/**
 * Before and after pairs for the demo (SPEC 15): a crop of Esri World Imagery
 * centred on the lot, cut from zoom 19 tiles. World Imagery has one date, so
 * both photos of a pair show the same ground. jpeg-js is a dev dependency;
 * without it, or without the network, the seed leaves the lots unphotographed.
 */
import { db } from "./db/index.ts";
import { lotPhotos, type Lot } from "./db/schema.ts";
import { photoPath } from "./photos.ts";

const TILE = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/19/{y}/{x}";
const Z = 19;
const W = 768;
const H = 576;
const THUMB_W = 320;
const THUMB_H = 240;

type Codec = typeof import("jpeg-js");

const tileXY = (lat: number, lng: number): { x: number; y: number } => {
  const n = 2 ** Z;
  const r = (lat * Math.PI) / 180;
  return { x: ((lng + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
};

const fetchTile = async (x: number, y: number): Promise<Uint8Array> => {
  const res = await fetch(TILE.replace("{x}", String(x)).replace("{y}", String(y)), {
    headers: { "User-Agent": "lrbuddy/1.0 (me@filipkin.com)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`tile ${x},${y}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

/** RGBA pixels of a W x H crop centred on the point. */
const crop = async (codec: Codec, lat: number, lng: number): Promise<Uint8Array> => {
  const c = tileXY(lat, lng);
  const left = Math.round(c.x * 256 - W / 2);
  const top = Math.round(c.y * 256 - H / 2);
  const tx0 = Math.floor(left / 256);
  const ty0 = Math.floor(top / 256);
  const tx1 = Math.floor((left + W - 1) / 256);
  const ty1 = Math.floor((top + H - 1) / 256);
  const out = new Uint8Array(W * H * 4);
  const jobs: Array<Promise<void>> = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(
        fetchTile(tx, ty).then((bytes) => {
          const img = codec.decode(bytes, { useTArray: true, formatAsRGBA: true });
          for (let py = 0; py < img.height; py++) {
            const oy = ty * 256 + py - top;
            if (oy < 0 || oy >= H) continue;
            for (let px = 0; px < img.width; px++) {
              const ox = tx * 256 + px - left;
              if (ox < 0 || ox >= W) continue;
              const si = (py * img.width + px) * 4;
              const di = (oy * W + ox) * 4;
              out[di] = img.data[si]!;
              out[di + 1] = img.data[si + 1]!;
              out[di + 2] = img.data[si + 2]!;
              out[di + 3] = 255;
            }
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
  return out;
};

/** Area-average downscale, good enough for a 2.4x shrink. */
const shrink = (src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array => {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * sw + xx) * 4;
          r += src[i]!;
          g += src[i + 1]!;
          b += src[i + 2]!;
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return out;
};

export interface SeedPhotoTarget {
  lot: Lot;
  ccId: number;
  dayId: number;
  crewId: number | null;
  takenBy: string;
  beforeAt: number;
  afterAt: number;
}

/** Writes a before and an after for each target. Returns how many lots got a pair. */
export const seedLotPhotos = async (targets: readonly SeedPhotoTarget[]): Promise<number> => {
  let codec: Codec;
  try {
    codec = await import("jpeg-js");
  } catch {
    console.warn("[seed] jpeg-js not installed, no demo photos");
    return 0;
  }
  let done = 0;
  for (const t of targets) {
    let full: Uint8Array;
    let thumb: Uint8Array;
    try {
      const rgba = await crop(codec, t.lot.lat, t.lot.lng);
      full = new Uint8Array(codec.encode({ width: W, height: H, data: rgba }, 82).data);
      thumb = new Uint8Array(codec.encode({ width: THUMB_W, height: THUMB_H, data: shrink(rgba, W, H, THUMB_W, THUMB_H) }, 82).data);
    } catch (err) {
      console.warn("[seed] World Imagery fetch failed, lot left without photos:", err instanceof Error ? err.message : String(err));
      continue;
    }
    for (const [kind, at] of [["before", t.beforeAt], ["after", t.afterAt]] as const) {
      const row = db
        .insert(lotPhotos)
        .values({
          lotId: t.lot.id,
          kind,
          sessionId: null,
          takenBy: t.takenBy,
          role: "crew",
          crewId: t.crewId,
          truckId: null,
          ccId: t.ccId,
          dayId: t.dayId,
          at,
          lat: t.lot.lat,
          lng: t.lot.lng,
          width: W,
          height: H,
          bytes: full.byteLength,
        })
        .returning()
        .get();
      await Bun.write(photoPath(row.id), full);
      await Bun.write(photoPath(row.id, true), thumb);
    }
    done++;
  }
  return done;
};
