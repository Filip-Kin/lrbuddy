import { useSyncExternalStore } from "react";
import { currentFix } from "../../../lib/position.ts";
import { postPhoto } from "../../../lib/photos.ts";

/**
 * After photos from Wrap up's camera (SPEC 28), posted in the background so the shutter goes
 * straight back to the list. Same behaviour as the Flag screen's queue: in memory, in order, a
 * retry after 2, 4, 8 and then every 15 s with no signal and at once when the phone comes back
 * online; a refusal (too big, signed out, lot gone) stops that photo with the server's reason.
 * Module state, so leaving Wrap up does not drop a photo still queued.
 */

const RETRY_MS = [2000, 4000, 8000, 15_000] as const;

export interface QueuedAfter {
  id: number;
  lotId: number;
  /** Object URL of the thumb, shown on the row until the server's thumb replaces it. */
  preview: string;
  phase: "queued" | "sending" | "done" | "failed";
  message: string | null;
  tries: number;
  /** When the server took it; the list counts it as taken until its next refetch. */
  savedAt: number | null;
}

interface Entry extends QueuedAfter {
  photo: Blob | null;
  thumb: Blob | null;
  lat: number | null;
  lng: number | null;
}

let entries: Entry[] = [];
let snapshot: readonly QueuedAfter[] = [];
let nextId = 1;
let busy = false;
let timer: number | null = null;
const listeners = new Set<() => void>();
const savedListeners = new Set<(lotId: number) => void>();

const publish = (): void => {
  snapshot = entries.map(({ id, lotId, preview, phase, message, tries, savedAt }) => ({ id, lotId, preview, phase, message, tries, savedAt }));
  for (const l of listeners) l();
};

const patch = (id: number, p: Partial<Entry>): void => {
  entries = entries.map((e) => (e.id === id ? { ...e, ...p } : e));
  publish();
};

const send = async (e: Entry): Promise<void> => {
  if (!e.photo || !e.thumb) return;
  patch(e.id, { phase: "sending" });
  const form = new FormData();
  form.set("lotId", String(e.lotId));
  form.set("kind", "after");
  if (e.lat !== null && e.lng !== null) {
    form.set("lat", String(e.lat));
    form.set("lng", String(e.lng));
  }
  form.set("photo", e.photo, "photo.jpg");
  form.set("thumb", e.thumb, "thumb.jpg");
  const r = await postPhoto(form, () => undefined);
  if (r.ok) {
    patch(e.id, { phase: "done", photo: null, thumb: null, message: null, savedAt: Date.now() });
    for (const l of savedListeners) l(e.lotId);
  } else if (r.refused) {
    patch(e.id, { phase: "failed", photo: null, thumb: null, message: r.message });
  } else {
    patch(e.id, { phase: "queued", tries: e.tries + 1, message: r.message });
  }
};

const pump = async (): Promise<void> => {
  if (busy) return;
  busy = true;
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  try {
    for (;;) {
      const e = entries.find((x) => x.phase === "queued");
      if (!e) break;
      await send(e);
      const after = entries.find((x) => x.id === e.id);
      if (after?.phase === "queued") {
        // Still no signal: wait, then the same photo again so the order holds.
        const wait = RETRY_MS[Math.min(after.tries - 1, RETRY_MS.length - 1)] ?? 15_000;
        timer = window.setTimeout(() => void pump(), wait);
        break;
      }
    }
  } finally {
    busy = false;
  }
};

if (typeof window !== "undefined") window.addEventListener("online", () => void pump());

/** Queues the After of a lot and starts sending it; `at` is where the phone stood, when known. */
export const queueAfter = (lotId: number, blobs: { photo: Blob; thumb: Blob }, at: { lat: number; lng: number } | null): void => {
  const fix = at ?? currentFix();
  entries = [
    ...entries,
    {
      id: nextId++,
      lotId,
      preview: URL.createObjectURL(blobs.thumb),
      phase: "queued",
      message: null,
      tries: 0,
      savedAt: null,
      photo: blobs.photo,
      thumb: blobs.thumb,
      lat: fix?.lat ?? null,
      lng: fix?.lng ?? null,
    },
  ];
  publish();
  void pump();
};

/** Called with the lot id each time an After reaches the server. */
export const onAfterSaved = (fn: (lotId: number) => void): (() => void) => {
  savedListeners.add(fn);
  return () => {
    savedListeners.delete(fn);
  };
};

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** Every After taken this session, oldest first. */
export const useAfterQueue = (): readonly QueuedAfter[] => useSyncExternalStore(subscribe, () => snapshot);
