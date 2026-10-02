/**
 * Paint mode (SPEC 23): one stroke across the map is one batch of SPEC 21
 * status writes (or crew assignments), applied in one transaction with the
 * same role rules as a single tap, and undoable stroke by stroke.
 *
 * The undo history lives in memory per session and CC, up to 20 strokes. A
 * restart forgets it; the lots themselves are in the database as always.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import { crews, LOT_STATUSES, lotPhotos, lots, surveyTags, type Lot, type LotStatus } from "./db/schema.ts";
import { emitLot } from "./lots-import.ts";
import { checkPlace, setLot, type Actor } from "./parcel-status.ts";

/** Strokes kept for Undo per session and CC. */
export const PAINT_HISTORY = 20;
/** Most parcels one stroke may carry. */
export const PAINT_MAX = 500;

/**
 * `toggle` is the Flag map's brush (SPEC 22): Todo becomes Not todo, Not todo
 * (or a bare parcel) becomes Todo, decided per parcel from its status now;
 * In progress, Done and Do not touch are left alone.
 */
export type Brush = { kind: "status"; status: LotStatus } | { kind: "crew"; crewId: number } | { kind: "toggle" };

/** The status the toggle brush gives a parcel in `status` (null for bare), or null to leave it. */
export const toggled = (status: LotStatus | null): LotStatus | null => (status === "open" ? "not_todo" : status === null || status === "not_todo" ? "open" : null);

/** The stroke as the routers take it. */
export const paintInput = z.object({
  brush: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("status"), status: z.enum(LOT_STATUSES) }),
    z.object({ kind: z.literal("crew"), crewId: z.number().int() }),
    z.object({ kind: z.literal("toggle") }),
  ]),
  lotIds: z.array(z.number().int()).max(PAINT_MAX),
  parcelIds: z.array(z.string().min(1).max(40)).max(PAINT_MAX),
});

export interface PaintInput {
  brush: Brush;
  lotIds: readonly number[];
  parcelIds: readonly string[];
}

// #region history
/** What a stroke changed on one lot, enough to put it back. */
type Entry =
  /** The stroke made the lot (a bare parcel painted). Undo deletes it. */
  | { kind: "created"; lotId: number; wrote: Wrote }
  /** The stroke changed the lot. Undo restores these fields. */
  | { kind: "updated"; lotId: number; before: Pick<Lot, "status" | "statusAt" | "statusByCrewId" | "crewId" | "ccId">; wrote: Wrote }
  /** The stroke deleted an untouched lot (Not todo). Undo puts the row back, and takes back the survey clear it added. */
  | { kind: "deleted"; lot: Lot; clearedTagId: number | null };

/** The fields the stroke wrote; Undo leaves a lot alone when someone changed them since. */
interface Wrote {
  status: LotStatus;
  crewId: number | null;
}

interface Stroke {
  at: number;
  entries: Entry[];
}

const history = new Map<string, Stroke[]>();
const historyKey = (sessionId: string, ccId: number): string => `${sessionId}:${ccId}`;

/** Strokes Undo can still take back for this session at this CC. */
export const paintDepth = (sessionId: string, ccId: number): number => history.get(historyKey(sessionId, ccId))?.length ?? 0;

/** For tests: forget every stroke. */
export const clearPaintHistory = (): void => history.clear();
// #endregion

const bad = (message: string): TRPCError => new TRPCError({ code: "BAD_REQUEST", message });

export interface PaintResult {
  /** Lots written by this stroke. */
  changed: number;
  /** Parcels already in the brush's status (or crew), or that the toggle brush leaves alone. */
  skipped: number;
  /** Parcels the role rules refused. */
  refused: number;
  /** Strokes Undo can take back now. */
  strokes: number;
}

/**
 * Applies one stroke. Each parcel goes through `setLot` (status brushes) or
 * the crew rule (Crew brush); a parcel the role may not touch is counted in
 * `refused` and the rest still apply. lot.changed goes out once per written
 * lot after the transaction commits.
 */
export const paint = (actor: Actor, sessionId: string, input: PaintInput, by: string | null): PaintResult => {
  const total = input.lotIds.length + input.parcelIds.length;
  if (total === 0) throw bad("Nothing painted");
  if (total > PAINT_MAX) throw bad("Stroke too long");
  const brush = input.brush;
  if (brush.kind === "crew") {
    const crew = db.select().from(crews).where(eq(crews.id, brush.crewId)).get();
    if (!crew || crew.ccId !== actor.cc.id) throw bad("Crew not at this command center");
  }
  const emits: Lot[] = [];
  const entries: Entry[] = [];
  let skipped = 0;
  let refused = 0;
  // A lot id and its parcel id in one stroke are one parcel.
  const seenLots = new Set<number>();
  const targets: Array<{ lotId: number } | { parcelId: string }> = [
    ...[...new Set(input.lotIds)].map((lotId) => ({ lotId })),
    ...[...new Set(input.parcelIds)].map((parcelId) => ({ parcelId })),
  ];

  db.transaction(() => {
    for (const t of targets) {
      const before =
        "lotId" in t
          ? (db.select().from(lots).where(eq(lots.id, t.lotId)).get() ?? null)
          : (db.select().from(lots).where(and(eq(lots.eventId, actor.event.id), eq(lots.parcelId, t.parcelId))).get() ?? null);
      if ("lotId" in t && (!before || before.eventId !== actor.event.id)) {
        refused++;
        continue;
      }
      if (before) {
        if (seenLots.has(before.id)) continue;
        seenLots.add(before.id);
      }
      try {
        if (brush.kind === "crew") {
          // Crew goes on work lots; a bare parcel or a Not todo lot has nothing to assign.
          if (!before || before.status === "not_todo" || before.crewId === brush.crewId) {
            skipped++;
            continue;
          }
          checkPlace(actor, { lot: before, parcelId: before.parcelId, point: { lat: before.lat, lng: before.lng } });
          const updated = db.update(lots).set({ crewId: brush.crewId }).where(eq(lots.id, before.id)).returning().get();
          emits.push(updated);
          entries.push({ kind: "updated", lotId: before.id, before: pick(before), wrote: { status: updated.status, crewId: updated.crewId } });
          continue;
        }
        const status = brush.kind === "toggle" ? toggled(before?.status ?? null) : brush.status;
        if (status === null || (before && before.status === status) || (!before && status === "not_todo")) {
          skipped++;
          continue;
        }
        const res = setLot(actor, before ? { lotId: before.id, status } : { parcelId: (t as { parcelId: string }).parcelId, status }, by, { emit: (l) => emits.push(l) });
        if (!before && res.lot) entries.push({ kind: "created", lotId: res.lot.id, wrote: { status: res.lot.status, crewId: res.lot.crewId } });
        else if (before && res.deleted) entries.push({ kind: "deleted", lot: before, clearedTagId: res.clearedTagId ?? null });
        else if (before && res.lot) entries.push({ kind: "updated", lotId: before.id, before: pick(before), wrote: { status: res.lot.status, crewId: res.lot.crewId } });
      } catch (err) {
        if (err instanceof TRPCError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) {
          refused++;
          continue;
        }
        throw err;
      }
    }
  });

  for (const l of emits) emitLot(l);
  const key = historyKey(sessionId, actor.cc.id);
  const list = history.get(key) ?? [];
  if (entries.length > 0) {
    list.push({ at: Date.now(), entries });
    while (list.length > PAINT_HISTORY) list.shift();
    history.set(key, list);
  }
  return { changed: entries.length, skipped, refused, strokes: list.length };
};

const pick = (l: Lot): Pick<Lot, "status" | "statusAt" | "statusByCrewId" | "crewId" | "ccId"> => ({
  status: l.status,
  statusAt: l.statusAt,
  statusByCrewId: l.statusByCrewId,
  crewId: l.crewId,
  ccId: l.ccId,
});

export interface UndoResult {
  /** Lots put back. */
  restored: number;
  /** Lots someone changed after the stroke, left as they are now. */
  kept: number;
  strokes: number;
}

/**
 * Takes back the session's last stroke at this CC: lots it made are deleted
 * (kept as Not todo if someone added a photo or note since), lots it changed
 * get their earlier status and crew, lots it deleted come back with the same
 * id. A lot changed by anyone after the stroke is left as it is now.
 */
export const undoPaint = (actor: Actor, sessionId: string): UndoResult => {
  const key = historyKey(sessionId, actor.cc.id);
  const list = history.get(key) ?? [];
  const stroke = list.pop();
  if (!stroke) throw bad("Nothing to undo");
  const emits: Lot[] = [];
  let restored = 0;
  let kept = 0;
  const same = (l: Lot, w: Wrote): boolean => l.status === w.status && l.crewId === w.crewId;

  db.transaction(() => {
    for (const e of [...stroke.entries].reverse()) {
      if (e.kind === "created") {
        const now = db.select().from(lots).where(eq(lots.id, e.lotId)).get();
        if (!now || !same(now, e.wrote)) {
          kept++;
          continue;
        }
        const photo = db.select({ id: lotPhotos.id }).from(lotPhotos).where(and(eq(lotPhotos.lotId, now.id), isNull(lotPhotos.deletedAt))).limit(1).get();
        if (photo || (now.note && now.note.trim() !== "")) {
          emits.push(db.update(lots).set({ status: "not_todo", statusAt: Date.now(), statusByCrewId: null }).where(eq(lots.id, now.id)).returning().get());
        } else {
          db.delete(lots).where(eq(lots.id, now.id)).run();
          emits.push(now);
        }
        restored++;
      } else if (e.kind === "updated") {
        const now = db.select().from(lots).where(eq(lots.id, e.lotId)).get();
        if (!now || !same(now, e.wrote)) {
          kept++;
          continue;
        }
        emits.push(db.update(lots).set(e.before).where(eq(lots.id, now.id)).returning().get());
        restored++;
      } else {
        const taken =
          db.select({ id: lots.id }).from(lots).where(eq(lots.id, e.lot.id)).get() ??
          (e.lot.parcelId ? db.select({ id: lots.id }).from(lots).where(and(eq(lots.eventId, e.lot.eventId), eq(lots.parcelId, e.lot.parcelId))).get() : undefined);
        if (taken) {
          kept++;
          continue;
        }
        emits.push(db.insert(lots).values(e.lot).returning().get());
        if (e.clearedTagId !== null) db.delete(surveyTags).where(eq(surveyTags.id, e.clearedTagId)).run();
        restored++;
      }
    }
  });

  for (const l of emits) emitLot(l);
  if (list.length === 0) history.delete(key);
  return { restored, kept, strokes: list.length };
};
