import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Zip, ZipPassThrough } from "fflate";
import { getSession, isAdminSession, sessionIdFrom } from "./auth.ts";
import { dataDir, db } from "./db/index.ts";
import {
  commandCenters,
  companies,
  crews,
  days,
  lotPhotos,
  lots,
  PHOTO_KINDS,
  trucks,
  type Crew,
  type Lot,
  type LotPhoto,
  type PhotoKind,
  type Role,
  type Session,
  type Truck,
} from "./db/schema.ts";
import { crewLabel, latestPosition } from "./dispatch.ts";
import { haversine } from "./geo.ts";
import { emitLot } from "./lots-import.ts";
import { siteCcIds } from "./queries.ts";

/** Crews may photograph a lot this close to their last position, as for lot status (SPEC 8). */
export const PHOTO_NEARBY_M = 400;
export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

// #region files
export const photoDir = join(dataDir, "photos");
mkdirSync(photoDir, { recursive: true });

export const photoPath = (id: number, thumb = false): string => join(photoDir, thumb ? `${id}.thumb.jpg` : `${id}.jpg`);

const removeFiles = (id: number): void => {
  rmSync(photoPath(id), { force: true });
  rmSync(photoPath(id, true), { force: true });
};

/**
 * Deletes files with no live row: photos deleted while a write was in flight,
 * and photos whose lot or event was deleted (the rows go by cascade). Runs at
 * boot and after admin lot deletes.
 */
export const sweepPhotoFiles = (): number => {
  if (!existsSync(photoDir)) return 0;
  const live = new Set(db.select({ id: lotPhotos.id }).from(lotPhotos).where(isNull(lotPhotos.deletedAt)).all().map((r) => r.id));
  let removed = 0;
  for (const name of readdirSync(photoDir)) {
    const m = /^(\d+)(\.thumb)?\.jpg$/.exec(name);
    if (m && live.has(Number(m[1]))) continue;
    rmSync(join(photoDir, name), { force: true });
    removed++;
  }
  return removed;
};
// #endregion

// #region jpeg
export const isJpeg = (b: Uint8Array): boolean => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Width and height from the first SOF marker; null when the stream has none. */
export const jpegSize = (b: Uint8Array): { width: number; height: number } | null => {
  if (!isJpeg(b)) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = (b[i + 5]! << 8) | b[i + 6]!;
      const width = (b[i + 7]! << 8) | b[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    i += 2 + len;
  }
  return null;
};
// #endregion

// #region scope and rules
/** Who a session is for the photo rules: its crew or truck, CC, day and event. Admin has none. */
export interface PhotoScope {
  session: Session;
  role: Role;
  crew: Crew | null;
  truck: Truck | null;
  ccId: number | null;
  dayId: number | null;
  eventId: number | null;
}

export const photoScope = (session: Session): PhotoScope | null => {
  let crew: Crew | null = null;
  let truck: Truck | null = null;
  let ccId: number | null = null;
  if (session.role === "admin") return isAdminSession(session) ? { session, role: "admin", crew, truck, ccId: null, dayId: null, eventId: null } : null;
  if (session.role === "crew" && session.crewId !== null) {
    crew = db.select().from(crews).where(eq(crews.id, session.crewId)).get() ?? null;
    if (!crew) return null;
    ccId = crew.ccId;
  } else if (session.role === "driver" && session.truckId !== null) {
    truck = db.select().from(trucks).where(eq(trucks.id, session.truckId)).get() ?? null;
    if (!truck) return null;
    ccId = truck.ccId;
  } else if (session.role === "green") {
    ccId = session.ccId;
  }
  if (ccId === null || session.role === "none") return null;
  const row = db
    .select({ dayId: commandCenters.dayId, eventId: days.eventId })
    .from(commandCenters)
    .innerJoin(days, eq(days.id, commandCenters.dayId))
    .where(eq(commandCenters.id, ccId))
    .get();
  if (!row) return null;
  return { session, role: session.role, crew, truck, ccId, dayId: row.dayId, eventId: row.eventId };
};

const atSite = (ccId: number | null, lot: Pick<Lot, "ccId">): boolean => ccId !== null && lot.ccId !== null && siteCcIds(ccId).includes(lot.ccId);

/**
 * SPEC 15: crew may photograph lots at its CC or within 400 m of its last
 * position (and its own lots); driver and green any lot at their CC; admin any lot.
 */
export const canPhotograph = (scope: PhotoScope, lot: Lot): boolean => {
  if (scope.role === "admin") return true;
  if (scope.eventId !== lot.eventId) return false;
  if (scope.crew) {
    if (lot.crewId === scope.crew.id || atSite(scope.ccId, lot)) return true;
    const p = latestPosition("crew", scope.crew.id);
    return p !== undefined && haversine(p, lot) <= PHOTO_NEARBY_M;
  }
  return atSite(scope.ccId, lot);
};

/** Anyone signed in to the lot's event sees its photos. */
export const canViewLot = (scope: PhotoScope, lot: Pick<Lot, "eventId">): boolean => scope.role === "admin" || scope.eventId === lot.eventId;

const DETROIT_DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Detroit", year: "numeric", month: "2-digit", day: "2-digit" });
export const detroitDate = (ms: number): string => DETROIT_DATE.format(new Date(ms));

/** The person who took a photo can delete it the same day (Detroit); green at the lot's CC and admin can delete any. */
export const canDeletePhoto = (scope: PhotoScope, photo: LotPhoto, lot: Pick<Lot, "ccId">, now = Date.now()): boolean => {
  if (scope.role === "admin") return true;
  if (scope.role === "green" && (atSite(scope.ccId, lot) || (photo.ccId !== null && atSite(scope.ccId, { ccId: photo.ccId })))) return true;
  return photo.sessionId === scope.session.id && detroitDate(photo.at) === detroitDate(now);
};

/** CC and day a photo is filed under: the taker's, or for admin the lot's site on today's date. */
const fileUnder = (scope: PhotoScope, lot: Lot, now: number): { ccId: number | null; dayId: number | null } => {
  if (scope.role !== "admin") return { ccId: scope.ccId, dayId: scope.dayId };
  if (lot.ccId === null) return { ccId: null, dayId: null };
  const ids = siteCcIds(lot.ccId);
  const rows = db
    .select({ id: commandCenters.id, dayId: commandCenters.dayId, date: days.date })
    .from(commandCenters)
    .innerJoin(days, eq(days.id, commandCenters.dayId))
    .where(inArray(commandCenters.id, ids))
    .all();
  const today = detroitDate(now);
  const pick = rows.find((r) => r.date === today) ?? rows.find((r) => r.id === lot.ccId);
  return pick ? { ccId: pick.id, dayId: pick.dayId } : { ccId: null, dayId: null };
};
// #endregion

// #region http
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const refuse = (status: number, error: string): Response => json({ ok: false, error }, status);

const num = (v: unknown): number | null => {
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export interface UploadedPhoto {
  id: number;
  lotId: number;
  kind: PhotoKind;
  at: number;
  width: number;
  height: number;
}

/**
 * `POST /photos`, multipart: `lotId`, `kind`, `photo` and `thumb` (JPEG, 6 MB
 * each at most), optional `lat` and `lng`. Writes both files, inserts the row,
 * emits `lot.changed`.
 */
export const handlePhotoUpload = async (req: Request, now = Date.now()): Promise<Response> => {
  const session = getSession(sessionIdFrom(req));
  if (!session) return refuse(401, "Sign in");
  const scope = photoScope(session);
  if (!scope) return refuse(401, "Sign in");
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > 2 * MAX_PHOTO_BYTES + 64 * 1024) return refuse(413, "Photo over 6 MB");
  const form = await req.formData().catch(() => null);
  if (!form) return refuse(400, "No photo");
  const lotId = num(form.get("lotId"));
  const kind = form.get("kind");
  if (lotId === null || !Number.isInteger(lotId)) return refuse(400, "No lot");
  if (typeof kind !== "string" || !(PHOTO_KINDS as readonly string[]).includes(kind)) return refuse(400, "Before or after required");
  const lot = db.select().from(lots).where(eq(lots.id, lotId)).get();
  if (!lot || !canViewLot(scope, lot)) return refuse(404, "Lot not found");
  if (!canPhotograph(scope, lot)) return refuse(403, "Lot not at this command center");
  const photo = form.get("photo");
  const thumb = form.get("thumb");
  if (!(photo instanceof Blob) || !(thumb instanceof Blob)) return refuse(400, "No photo");
  if (photo.size > MAX_PHOTO_BYTES || thumb.size > MAX_PHOTO_BYTES) return refuse(413, "Photo over 6 MB");
  const full = new Uint8Array(await photo.arrayBuffer());
  const small = new Uint8Array(await thumb.arrayBuffer());
  const size = jpegSize(full);
  if (!size || !isJpeg(small)) return refuse(400, "Photo not a JPEG");
  const lat = num(form.get("lat"));
  const lng = num(form.get("lng"));
  const where = fileUnder(scope, lot, now);
  const row = db
    .insert(lotPhotos)
    .values({
      lotId: lot.id,
      kind: kind as PhotoKind,
      sessionId: session.id,
      takenBy: session.displayName ?? (scope.crew ? crewLabel(scope.crew) : (scope.truck?.name ?? null)),
      role: scope.role,
      crewId: scope.crew?.id ?? null,
      truckId: scope.truck?.id ?? null,
      ccId: where.ccId,
      dayId: where.dayId,
      at: now,
      lat: lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? lat : null,
      lng: lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? lng : null,
      width: size.width,
      height: size.height,
      bytes: full.byteLength,
    })
    .returning()
    .get();
  try {
    await Bun.write(photoPath(row.id), full);
    await Bun.write(photoPath(row.id, true), small);
  } catch (err) {
    db.delete(lotPhotos).where(eq(lotPhotos.id, row.id)).run();
    removeFiles(row.id);
    console.error("[photos] write failed:", err instanceof Error ? err.message : String(err));
    return refuse(500, "Photo not saved. Try again.");
  }
  emitLot(lot);
  const out: UploadedPhoto = { id: row.id, lotId: lot.id, kind: row.kind, at: row.at, width: row.width, height: row.height };
  return json({ ok: true, photo: out });
};

/** `GET /photos/<id>` and `/photos/<id>/thumb` need a session of the lot's event. */
export const servePhoto = async (req: Request, id: number, thumb: boolean): Promise<Response> => {
  const session = getSession(sessionIdFrom(req));
  const scope = session ? photoScope(session) : null;
  if (!scope) return new Response("Sign in", { status: 401 });
  const row = db.select({ photo: lotPhotos, eventId: lots.eventId }).from(lotPhotos).innerJoin(lots, eq(lots.id, lotPhotos.lotId)).where(eq(lotPhotos.id, id)).get();
  if (!row || row.photo.deletedAt !== null || !canViewLot(scope, { eventId: row.eventId })) return new Response("Not found", { status: 404 });
  const file = Bun.file(photoPath(id, thumb));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000" } });
};
// #endregion

// #region delete
export type DeleteResult = { ok: true; photo: LotPhoto } | { ok: false; code: "NOT_FOUND" | "FORBIDDEN" };

/** Sets `deleted_at`, removes both files, emits `lot.changed`. */
export const deletePhoto = (scope: PhotoScope, id: number, now = Date.now()): DeleteResult => {
  const photo = db.select().from(lotPhotos).where(eq(lotPhotos.id, id)).get();
  const lot = photo ? db.select().from(lots).where(eq(lots.id, photo.lotId)).get() : undefined;
  if (!photo || !lot || photo.deletedAt !== null || !canViewLot(scope, lot)) return { ok: false, code: "NOT_FOUND" };
  if (!canDeletePhoto(scope, photo, lot, now)) return { ok: false, code: "FORBIDDEN" };
  const done = db.update(lotPhotos).set({ deletedAt: now }).where(eq(lotPhotos.id, id)).returning().get();
  removeFiles(id);
  emitLot(lot);
  return { ok: true, photo: done };
};
// #endregion

// #region reads
export interface PhotoView {
  id: number;
  kind: PhotoKind;
  at: number;
  takenBy: string | null;
  role: Role;
  width: number;
  height: number;
  canDelete: boolean;
}

/** Every live photo of a lot, newest first, with what this session may do. */
export const lotPhotoList = (scope: PhotoScope, lot: Lot, now = Date.now()) => {
  const rows = db
    .select()
    .from(lotPhotos)
    .where(and(eq(lotPhotos.lotId, lot.id), isNull(lotPhotos.deletedAt)))
    .orderBy(desc(lotPhotos.at), desc(lotPhotos.id))
    .all();
  const photos: PhotoView[] = rows.map((p) => ({
    id: p.id,
    kind: p.kind,
    at: p.at,
    takenBy: p.takenBy,
    role: p.role,
    width: p.width,
    height: p.height,
    canDelete: canDeletePhoto(scope, p, lot, now),
  }));
  return { lot: { id: lot.id, address: lot.address, parcelId: lot.parcelId }, canAdd: canPhotograph(scope, lot), photos };
};

export interface PhotoSummary {
  /** Newest live photo of each kind. */
  before: number | null;
  after: number | null;
  beforeCount: number;
  afterCount: number;
}

export type PairState = "none" | "before" | "after" | "both";

export const pairState = (s: PhotoSummary | undefined): PairState => {
  if (!s) return "none";
  if (s.before !== null && s.after !== null) return "both";
  if (s.before !== null) return "before";
  return s.after !== null ? "after" : "none";
};

/** Newest photo id and count per kind for every lot of the event that has one. */
export const photoSummary = (eventId: number): Map<number, PhotoSummary> => {
  const rows = db
    .select({ lotId: lotPhotos.lotId, kind: lotPhotos.kind, newest: sql<number>`max(${lotPhotos.id})`, n: sql<number>`count(*)` })
    .from(lotPhotos)
    .innerJoin(lots, eq(lots.id, lotPhotos.lotId))
    .where(and(eq(lots.eventId, eventId), isNull(lotPhotos.deletedAt)))
    .groupBy(lotPhotos.lotId, lotPhotos.kind)
    .all();
  const out = new Map<number, PhotoSummary>();
  for (const r of rows) {
    const s = out.get(r.lotId) ?? { before: null, after: null, beforeCount: 0, afterCount: 0 };
    if (r.kind === "before") {
      s.before = r.newest;
      s.beforeCount = r.n;
    } else {
      s.after = r.newest;
      s.afterCount = r.n;
    }
    out.set(r.lotId, s);
  }
  return out;
};

/**
 * Photo state for the camera badges: `hasBefore` for the Flag screen (a work lot with no Before),
 * `needsAfter` (a Before and no After) for Wrap up. A Not done lot needs no After: nothing changed
 * on it (SPEC 28). The day maps draw no badge.
 */
export const withPhotoState = <T extends { id: number; status: string }>(rows: readonly T[], summary: Map<number, PhotoSummary>): Array<T & { hasBefore: boolean; needsAfter: boolean }> =>
  rows.map((l) => {
    const s = summary.get(l.id);
    return { ...l, hasBefore: (s?.before ?? null) !== null, needsAfter: l.status !== "not_done" && pairState(s) === "before" };
  });

/** Lots with both kinds, and lots with a before and no after. */
export const photoCounts = (lotIds: readonly number[], summary: Map<number, PhotoSummary>): { both: number; missingAfter: number } => {
  let both = 0;
  let missingAfter = 0;
  for (const id of lotIds) {
    const st = pairState(summary.get(id));
    if (st === "both") both++;
    else if (st === "before") missingAfter++;
  }
  return { both, missingAfter };
};

export interface PhotoBrief {
  id: number;
  at: number;
  takenBy: string | null;
}

export interface PhotoPair {
  lotId: number;
  address: string | null;
  parcelId: string | null;
  status: Lot["status"];
  crewId: number | null;
  crewName: string | null;
  companyId: number | null;
  companyName: string | null;
  before: PhotoBrief | null;
  after: PhotoBrief | null;
  beforeCount: number;
  afterCount: number;
  latestAt: number;
}

/**
 * One pair per lot from a set of live photos: the newest before and the
 * newest after. The crew is the lot's crew, else the crew that took the
 * newest photo. Newest pair first.
 */
export const photoPairs = (photos: readonly LotPhoto[]): PhotoPair[] => {
  if (photos.length === 0) return [];
  const byLot = new Map<number, LotPhoto[]>();
  for (const p of photos) byLot.set(p.lotId, [...(byLot.get(p.lotId) ?? []), p]);
  const lotRows = new Map(db.select().from(lots).where(inArray(lots.id, [...byLot.keys()])).all().map((l) => [l.id, l]));
  const crewIds = new Set<number>();
  for (const [lotId, ps] of byLot) {
    const lot = lotRows.get(lotId);
    if (lot?.crewId != null) crewIds.add(lot.crewId);
    for (const p of ps) if (p.crewId !== null) crewIds.add(p.crewId);
  }
  const crewRows = new Map(
    crewIds.size === 0
      ? []
      : db
          .select({ crew: crews, company: companies })
          .from(crews)
          .leftJoin(companies, eq(companies.id, crews.companyId))
          .where(inArray(crews.id, [...crewIds]))
          .all()
          .map((r) => [r.crew.id, r]),
  );
  const out: PhotoPair[] = [];
  for (const [lotId, ps] of byLot) {
    const lot = lotRows.get(lotId);
    if (!lot) continue;
    const sorted = [...ps].sort((a, b) => b.at - a.at || b.id - a.id);
    const brief = (p: LotPhoto | undefined): PhotoBrief | null => (p ? { id: p.id, at: p.at, takenBy: p.takenBy } : null);
    const crewId = lot.crewId ?? sorted.find((p) => p.crewId !== null)?.crewId ?? null;
    const c = crewId !== null ? crewRows.get(crewId) : undefined;
    out.push({
      lotId,
      address: lot.address,
      parcelId: lot.parcelId,
      status: lot.status,
      crewId: c ? c.crew.id : null,
      crewName: c ? crewLabel(c.crew) : null,
      companyId: c?.company?.id ?? null,
      companyName: c?.company?.name ?? null,
      before: brief(sorted.find((p) => p.kind === "before")),
      after: brief(sorted.find((p) => p.kind === "after")),
      beforeCount: ps.filter((p) => p.kind === "before").length,
      afterCount: ps.filter((p) => p.kind === "after").length,
      latestAt: sorted[0]!.at,
    });
  }
  return out.sort((a, b) => b.latestAt - a.latestAt);
};

export interface PairFilter {
  companyId?: number | null;
  crewId?: number | null;
  status?: Lot["status"] | null;
  missingAfter?: boolean | null;
}

export const filterPairs = (pairs: readonly PhotoPair[], f: PairFilter): PhotoPair[] =>
  pairs.filter(
    (p) =>
      (f.companyId == null || p.companyId === f.companyId) &&
      (f.crewId == null || p.crewId === f.crewId) &&
      (f.status == null || p.status === f.status) &&
      (!f.missingAfter || (p.before !== null && p.after === null)),
  );

/** Live photos of lots at a CC's site, any day. */
export const sitePhotos = (ccId: number): LotPhoto[] =>
  db
    .select({ p: lotPhotos })
    .from(lotPhotos)
    .innerJoin(lots, eq(lots.id, lotPhotos.lotId))
    .where(and(isNull(lotPhotos.deletedAt), inArray(lots.ccId, siteCcIds(ccId))))
    .all()
    .map((r) => r.p);

/** Live photos of the event, optionally taken on one day and at one CC row. */
export const eventPhotos = (eventId: number, f: { dayId?: number | null; ccId?: number | null } = {}): LotPhoto[] =>
  db
    .select({ p: lotPhotos })
    .from(lotPhotos)
    .innerJoin(lots, eq(lots.id, lotPhotos.lotId))
    .where(
      and(
        isNull(lotPhotos.deletedAt),
        eq(lots.eventId, eventId),
        f.dayId != null ? eq(lotPhotos.dayId, f.dayId) : undefined,
        f.ccId != null ? eq(lotPhotos.ccId, f.ccId) : undefined,
      ),
    )
    .orderBy(lotPhotos.at, lotPhotos.id)
    .all()
    .map((r) => r.p);
// #endregion

// #region pairs zip (SPEC 15)
export interface PairsZipLot {
  lotId: number;
  /** `pairs/<base>.jpg`, the side by side. */
  pairFile: string;
  /** Newest live Before and After, the two halves of the side by side. */
  before: number;
  after: number;
  /** "2208 Richton, Detroit". */
  title: string;
  /** "Six Day Project 2026  ·  Oct 2  ·  Stonefield Engineering & Design". */
  subtitle: string;
  /** Every live photo of both kinds: `raw/<base>_before.jpg`, `_before_1.jpg`, `_before_2.jpg` with more than one. */
  raw: Array<{ id: number; file: string }>;
}

/** "2208_Richton": a file name part from an address, letters, digits and underscores. */
const fileBase = (s: string): string =>
  s.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "lot";

const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/Detroit" });

/**
 * The Pairs zip: every lot with at least one live Before and one live After, newest pair first.
 * File names follow the address; two lots with the same address get `_2`, `_3`. The date on the
 * subtitle is the day of the newest After, Detroit time.
 */
export const pairsZip = (photos: readonly LotPhoto[], year: number): PairsZipLot[] => {
  const pairs = photoPairs(photos).filter((p) => p.before !== null && p.after !== null);
  const byLot = new Map<number, LotPhoto[]>();
  for (const p of photos) byLot.set(p.lotId, [...(byLot.get(p.lotId) ?? []), p]);
  const taken = new Map<string, number>();
  return pairs.map((p) => {
    const name = p.address ?? (p.parcelId ? `Parcel ${p.parcelId}` : `Lot ${p.lotId}`);
    let base = fileBase(name);
    const n = (taken.get(base.toLowerCase()) ?? 0) + 1;
    taken.set(base.toLowerCase(), n);
    if (n > 1) base = `${base}_${n}`;
    const raw: Array<{ id: number; file: string }> = [];
    for (const kind of ["before", "after"] as const) {
      const list = (byLot.get(p.lotId) ?? []).filter((x) => x.kind === kind).sort((a, b) => a.at - b.at || a.id - b.id);
      list.forEach((x, i) => raw.push({ id: x.id, file: `raw/${base}_${kind}${list.length > 1 ? `_${i + 1}` : ""}.jpg` }));
    }
    const subtitle = [`Six Day Project ${year}`, MONTH_DAY.format(new Date(p.after!.at)), p.companyName].filter(Boolean).join("  ·  ");
    return { lotId: p.lotId, pairFile: `pairs/${base}.jpg`, before: p.before!.id, after: p.after!.id, title: `${name}, Detroit`, subtitle, raw };
  });
};
// #endregion

// #region zip and csv names
const slugPart = (s: string | null | undefined, fallback: string): string =>
  (s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || fallback;

/**
 * `<day>_<cc>_<address>_<before|after>_<n>.jpg`, n counting from 1 per name in
 * the order taken. Photos in time order give stable numbers.
 */
export const photoFileNames = (photos: readonly LotPhoto[]): Map<number, string> => {
  const lotIds = [...new Set(photos.map((p) => p.lotId))];
  const lotRows = new Map(lotIds.length ? db.select().from(lots).where(inArray(lots.id, lotIds)).all().map((l) => [l.id, l]) : []);
  const dayIds = [...new Set(photos.map((p) => p.dayId).filter((x): x is number => x !== null))];
  const ccIds = [...new Set(photos.map((p) => p.ccId).filter((x): x is number => x !== null))];
  const dayLabel = new Map(dayIds.length ? db.select().from(days).where(inArray(days.id, dayIds)).all().map((d) => [d.id, d.label]) : []);
  const ccName = new Map(ccIds.length ? db.select().from(commandCenters).where(inArray(commandCenters.id, ccIds)).all().map((c) => [c.id, c.name]) : []);
  const seen = new Map<string, number>();
  const out = new Map<number, string>();
  for (const p of [...photos].sort((a, b) => a.at - b.at || a.id - b.id)) {
    const lot = lotRows.get(p.lotId);
    const addr = lot?.address ?? (lot?.parcelId ? `parcel ${lot.parcelId}` : null);
    const base = [
      slugPart(p.dayId !== null ? dayLabel.get(p.dayId) : null, "no-day"),
      slugPart(p.ccId !== null ? ccName.get(p.ccId) : null, "no-cc"),
      slugPart(addr, "lot"),
      p.kind,
    ].join("_");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(p.id, `${base}_${n}.jpg`);
  }
  return out;
};

/**
 * Zip of the photos, stored without compression (JPEGs do not shrink), one
 * file read per pull so memory holds one photo at a time.
 */
export const photoZipStream = (photos: readonly LotPhoto[]): ReadableStream<Uint8Array> => {
  const names = photoFileNames(photos);
  const queue = [...photos];
  let zip: Zip | null = null;
  let ended = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((err, chunk, final) => {
        if (err) {
          controller.error(err);
          return;
        }
        controller.enqueue(chunk);
        if (final) controller.close();
      });
    },
    async pull() {
      if (!zip || ended) return;
      // A pull that enqueues nothing is never followed by another, so a photo whose
      // file is gone (deleted while the zip streams) is skipped here, not by returning.
      for (;;) {
        const next = queue.shift();
        if (!next) {
          ended = true;
          zip.end();
          return;
        }
        const file = Bun.file(photoPath(next.id));
        if (!(await file.exists())) continue;
        const entry = new ZipPassThrough(names.get(next.id) ?? `${next.id}.jpg`);
        entry.mtime = next.at;
        zip.add(entry);
        entry.push(new Uint8Array(await file.arrayBuffer()), true);
        return;
      }
    },
    cancel() {
      ended = true;
      zip?.terminate();
    },
  });
};
// #endregion
