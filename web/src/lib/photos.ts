import { useCallback, useEffect, useRef, useState } from "react";
import { currentFix } from "./position.ts";
import { trpc } from "./trpc.ts";

export type PhotoKind = "before" | "after";

export const KIND_LABEL: Record<PhotoKind, string> = { before: "Before", after: "After" };

export const photoUrl = (id: number, thumb = false): string => `/photos/${id}${thumb ? "/thumb" : ""}`;

// #region resize
const LONG_EDGE = 1600;
const THUMB_EDGE = 320;
const QUALITY = 0.82;

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

/** Decodes with the EXIF orientation applied, so a portrait shot stays upright once EXIF is gone. */
const decode = async (file: Blob): Promise<Decoded> => {
  try {
    const b = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: b, width: b.width, height: b.height, close: () => b.close() };
  } catch {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error("Photo not readable");
    }
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  }
};

/** Redraws to a JPEG no longer than `edge` on its long side. A canvas carries no EXIF, so this also strips it. */
const toJpeg = (source: CanvasImageSource, width: number, height: number, edge: number): Promise<Blob> => {
  const scale = Math.min(1, edge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("Photo not readable"));
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Photo not readable"))), "image/jpeg", QUALITY));
};

/** The 1600 px photo and its 320 px thumb. */
export const preparePhoto = async (file: Blob): Promise<{ photo: Blob; thumb: Blob }> => {
  const img = await decode(file);
  try {
    const photo = await toJpeg(img.source, img.width, img.height, LONG_EDGE);
    const thumb = await toJpeg(img.source, img.width, img.height, THUMB_EDGE);
    return { photo, thumb };
  } finally {
    img.close();
  }
};

/** The photo and thumb from a frame already on screen (the Flag screen's camera). */
export const prepareFrame = async (source: CanvasImageSource, width: number, height: number): Promise<{ photo: Blob; thumb: Blob }> => ({
  photo: await toJpeg(source, width, height, LONG_EDGE),
  thumb: await toJpeg(source, width, height, THUMB_EDGE),
});
// #endregion

// #region upload
/** `refused`: the server answered no (a 4xx other than a timeout or rate limit); trying again cannot help. */
export type PostResult = { ok: true; id: number } | { ok: false; message: string; refused: boolean };

const refusedStatus = (status: number): boolean => status >= 400 && status < 500 && status !== 408 && status !== 429;

/** `POST /photos` (or `/tire-photos`, SPEC 29) through XHR, the one browser API that reports upload progress. */
export const postPhoto = (form: FormData, onProgress: (f: number) => void, url = "/photos"): Promise<PostResult> =>
  new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const photo = typeof rec.photo === "object" && rec.photo !== null ? (rec.photo as Record<string, unknown>) : null;
      if (xhr.status >= 200 && xhr.status < 300 && photo && typeof photo.id === "number") resolve({ ok: true, id: photo.id });
      else if (xhr.status === 401) resolve({ ok: false, message: "Signed out", refused: true });
      else resolve({ ok: false, message: typeof rec.error === "string" && rec.error.length < 80 ? rec.error : "Not sent", refused: refusedStatus(xhr.status) });
    };
    xhr.onerror = () => resolve({ ok: false, message: "No signal", refused: false });
    xhr.ontimeout = () => resolve({ ok: false, message: "No signal", refused: false });
    xhr.timeout = 120_000;
    xhr.send(form);
  });

export type UploadState =
  | { phase: "idle" }
  | { phase: "working"; preview: string; progress: number }
  | { phase: "failed"; preview: string; message: string }
  | { phase: "done"; preview: string; id: number };

/** Every query that shows a photo or a pair state. */
export const useInvalidatePhotos = (): (() => void) => {
  const utils = trpc.useUtils();
  return useCallback(() => {
    void utils.shared.lotPhotos.invalidate();
    void utils.crew.lots.invalidate();
    void utils.crew.map.invalidate();
    void utils.green.lots.invalidate();
    void utils.green.photos.invalidate();
    void utils.green.stats.invalidate();
    void utils.admin.photos.invalidate();
    void utils.admin.export.counts.invalidate();
  }, [utils]);
};

/**
 * One camera control's upload: resize, post with progress, keep the photo on
 * failure for Retry. The local preview stays up until the server's thumb
 * replaces it.
 */
/** A lot id, or a way to get one: a bare parcel's lot is created on the first photo (SPEC 21). */
export type LotRef = number | (() => Promise<number>);

export const usePhotoUpload = (lotRef: LotRef, kind: PhotoKind) => {
  const [state, setState] = useState<UploadState>({ phase: "idle" });
  const blobs = useRef<{ photo: Blob; thumb: Blob } | null>(null);
  const preview = useRef<string | null>(null);
  const refresh = useInvalidatePhotos();

  useEffect(
    () => () => {
      if (preview.current) URL.revokeObjectURL(preview.current);
    },
    [],
  );

  const send = useCallback(async (): Promise<void> => {
    const b = blobs.current;
    const url = preview.current;
    if (!b || !url) return;
    setState({ phase: "working", preview: url, progress: 0 });
    let lotId: number;
    try {
      lotId = typeof lotRef === "number" ? lotRef : await lotRef();
    } catch (err) {
      setState({ phase: "failed", preview: url, message: err instanceof Error && err.message.length < 80 ? err.message : "Lot not saved. Try again." });
      return;
    }
    const form = new FormData();
    form.set("lotId", String(lotId));
    form.set("kind", kind);
    const fix = currentFix();
    if (fix) {
      form.set("lat", String(fix.lat));
      form.set("lng", String(fix.lng));
    }
    form.set("photo", b.photo, "photo.jpg");
    form.set("thumb", b.thumb, "thumb.jpg");
    const r = await postPhoto(form, (f) => setState({ phase: "working", preview: url, progress: f }));
    if (r.ok) {
      blobs.current = null;
      setState({ phase: "done", preview: url, id: r.id });
      refresh();
    } else {
      setState({ phase: "failed", preview: url, message: r.message });
    }
  }, [lotRef, kind, refresh]);

  const pick = useCallback(
    async (file: File): Promise<void> => {
      if (preview.current) URL.revokeObjectURL(preview.current);
      const url = URL.createObjectURL(file);
      preview.current = url;
      setState({ phase: "working", preview: url, progress: 0 });
      try {
        blobs.current = await preparePhoto(file);
      } catch {
        blobs.current = null;
        setState({ phase: "failed", preview: url, message: "Photo not readable" });
        return;
      }
      await send();
    },
    [send],
  );

  return { state, pick, retry: send, reset: () => setState({ phase: "idle" }) };
};
// #endregion
