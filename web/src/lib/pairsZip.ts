import { Zip, ZipPassThrough } from "fflate";
import { photoUrl } from "./photos.ts";

/**
 * Pairs zip (SPEC 15), built in the browser: the server has no canvas. For each lot one side by
 * side JPEG with the address and the project line baked in, plus every raw photo of the lot.
 * Stored, not compressed: JPEGs do not shrink. One lot at a time, so memory holds one composite.
 */

export interface PairsZipLot {
  lotId: number;
  pairFile: string;
  before: number;
  after: number;
  title: string;
  subtitle: string;
  raw: ReadonlyArray<{ id: number; file: string }>;
}

// #region composite
/** The layout of Filip's reference (2208 Richton): photos 1400 px tall, a 12 px gap, a 170 px header, a 96 px footer. */
export const PAIR = { photoH: 1400, gap: 12, header: 170, footer: 96, pad: 36 } as const;
const TEAL = "#0e3038";
const SUB = "#c4dce2";
const YELLOW = "#ffd600";
const FONT = 'system-ui, "DejaVu Sans", "Segoe UI", Roboto, Arial, sans-serif';

const fetchBlob = async (id: number): Promise<Blob> => {
  const r = await fetch(photoUrl(id), { credentials: "same-origin" });
  if (!r.ok) throw new Error(`Photo ${id}: ${r.status}`);
  return r.blob();
};

/** A line of text at `size`, shrunk until it fits `max` px wide. */
const fitText = (ctx: CanvasRenderingContext2D, text: string, weight: string, size: number, max: number): void => {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (s > 18 && ctx.measureText(text).width > max) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
};

export const composePair = async (before: Blob, after: Blob, title: string, subtitle: string): Promise<Blob> => {
  const [a, b] = await Promise.all([createImageBitmap(before), createImageBitmap(after)]);
  try {
    const wa = Math.round((a.width * PAIR.photoH) / a.height);
    const wb = Math.round((b.width * PAIR.photoH) / b.height);
    const W = wa + PAIR.gap + wb;
    const H = PAIR.header + PAIR.photoH + PAIR.footer;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No canvas");
    ctx.fillStyle = TEAL;
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(a, 0, PAIR.header, wa, PAIR.photoH);
    ctx.drawImage(b, wa + PAIR.gap, PAIR.header, wb, PAIR.photoH);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#ffffff";
    fitText(ctx, title, "bold", 58, W - 2 * PAIR.pad);
    ctx.fillText(title, PAIR.pad, 76);
    ctx.fillStyle = SUB;
    fitText(ctx, subtitle, "normal", 36, W - 2 * PAIR.pad);
    ctx.fillText(subtitle, PAIR.pad, 138);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const y = PAIR.header + PAIR.photoH + PAIR.footer / 2;
    ctx.font = `bold 48px ${FONT}`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText("BEFORE", wa / 2, y);
    ctx.fillStyle = YELLOW;
    ctx.fillText("AFTER", wa + PAIR.gap + wb / 2, y);
    return await new Promise<Blob>((ok, fail) => canvas.toBlob((x) => (x ? ok(x) : fail(new Error("Not encoded"))), "image/jpeg", 0.9));
  } finally {
    a.close();
    b.close();
  }
};
// #endregion

/** Builds the zip; `onProgress(done, total)` after each lot. */
export const buildPairsZip = async (lots: readonly PairsZipLot[], onProgress: (done: number, total: number) => void): Promise<Blob> => {
  const parts: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else parts.push(chunk);
  });
  const add = async (name: string, blob: Blob): Promise<void> => {
    const f = new ZipPassThrough(name);
    zip.add(f);
    f.push(new Uint8Array(await blob.arrayBuffer()), true);
  };
  onProgress(0, lots.length);
  for (let i = 0; i < lots.length; i++) {
    const l = lots[i]!;
    const raw = new Map<number, Blob>();
    for (const r of l.raw) raw.set(r.id, await fetchBlob(r.id));
    const before = raw.get(l.before) ?? (await fetchBlob(l.before));
    const after = raw.get(l.after) ?? (await fetchBlob(l.after));
    await add(l.pairFile, await composePair(before, after, l.title, l.subtitle));
    for (const r of l.raw) await add(r.file, raw.get(r.id)!);
    onProgress(i + 1, lots.length);
    if (failure) throw failure;
  }
  zip.end();
  if (failure) throw failure;
  return new Blob(parts as BlobPart[], { type: "application/zip" });
};

/** Saves a blob as a download. */
export const saveBlob = (blob: Blob, name: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
