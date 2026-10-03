import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { getSession, holdsGreen, isAdminSession, sessionIdFrom } from "./auth.ts";
import { bus } from "./bus.ts";
import { dataDir, db } from "./db/index.ts";
import { tirePiles, type CommandCenter, type Crew, type Day, type Event, type Session, type TirePile, type Truck } from "./db/schema.ts";
import { crewLabel } from "./dispatch.ts";
import { isJpeg, jpegSize, MAX_PHOTO_BYTES, photoScope } from "./photos.ts";

/**
 * Tire piles (SPEC 29): a marker where a crew, a truck or a green shirt stacked tires by the road
 * for a truck to pick up. Every role at the CC sees every pile of that CC and day. Crews and trucks
 * add piles and delete their own; green shirts (and anyone holding green there, SPEC 27) add, move
 * and delete any and take the photo in Wrap up.
 */

// #region files
export const tirePhotoDir = join(dataDir, "tire-photos");
mkdirSync(tirePhotoDir, { recursive: true });

export const tirePhotoPath = (id: number, thumb = false): string => join(tirePhotoDir, thumb ? `${id}.thumb.jpg` : `${id}.jpg`);

const removeTireFiles = (id: number): void => {
  rmSync(tirePhotoPath(id), { force: true });
  rmSync(tirePhotoPath(id, true), { force: true });
};

/** Deletes photo files of piles that are gone (a CC, day or event deleted by cascade). Runs at boot. */
export const sweepTireFiles = (): number => {
  if (!existsSync(tirePhotoDir)) return 0;
  const live = new Set(db.select({ id: tirePiles.id }).from(tirePiles).all().map((r) => r.id));
  let removed = 0;
  for (const name of readdirSync(tirePhotoDir)) {
    const m = /^(\d+)(\.thumb)?\.jpg$/.exec(name);
    if (m && live.has(Number(m[1]))) continue;
    rmSync(join(tirePhotoDir, name), { force: true });
    removed++;
  }
  return removed;
};
// #endregion

// #region rules
/** Who is acting, as the CC procedures resolve it. */
export interface TireActor {
  session: Session;
  cc: CommandCenter;
  day: Day;
  event: Event;
  crew: Crew | null;
  truck: Truck | null;
}

/** Green shirt powers at this CC: a green or admin session, or a person holding green here (SPEC 27). */
export const greenAt = (a: Pick<TireActor, "session" | "cc">): boolean =>
  a.session.role === "green" || isAdminSession(a.session) || holdsGreen(a.session.userId, a.cc.id);

export interface TirePileView {
  id: number;
  lat: number;
  lng: number;
  /** Crew name or green shirt name. */
  madeBy: string;
  role: TirePile["role"];
  crewId: number | null;
  truckId: number | null;
  createdAt: number;
  /** When the current photo was taken; null with no photo. Also the photo URL's version. */
  photoAt: number | null;
  photoBy: string | null;
  count: number | null;
  side: "left" | "right" | null;
  /** Made by this crew or this truck. */
  mine: boolean;
  canMove: boolean;
  canDelete: boolean;
}

const view = (a: TireActor, p: TirePile): TirePileView => {
  const green = greenAt(a);
  const mine = (a.crew !== null && p.crewId === a.crew.id) || (a.truck !== null && p.truckId === a.truck.id);
  return {
    id: p.id,
    lat: p.lat,
    lng: p.lng,
    madeBy: p.madeBy ?? (p.role === "crew" ? "Crew" : p.role === "driver" ? "Truck" : "Green shirt"),
    role: p.role,
    crewId: p.crewId,
    truckId: p.truckId,
    createdAt: p.createdAt,
    photoAt: p.photoAt,
    photoBy: p.photoBy,
    count: p.count,
    side: p.side,
    mine,
    canMove: green,
    canDelete: green || mine,
  };
};

const emit = (p: Pick<TirePile, "id" | "ccId" | "dayId">, deleted = false): void => {
  bus.emit("tire.changed", { ccId: p.ccId, dayId: p.dayId }, { pileId: p.id, deleted });
};

const pileAt = (a: TireActor, id: number): TirePile => {
  const p = db.select().from(tirePiles).where(eq(tirePiles.id, id)).get();
  // A pile at another CC or day is not there for this session.
  if (!p || p.ccId !== a.cc.id) throw new TRPCError({ code: "NOT_FOUND", message: "Tire pile not found" });
  return p;
};
// #endregion

// #region actions
/** Every pile at the actor's CC on its day, oldest first. */
export const listPiles = (a: TireActor): TirePileView[] =>
  db
    .select()
    .from(tirePiles)
    .where(eq(tirePiles.ccId, a.cc.id))
    .orderBy(tirePiles.createdAt, tirePiles.id)
    .all()
    .map((p) => view(a, p));

/** A crew, a truck or a green shirt drops a pile, filed under the crew or truck when there is one. */
export const addPile = (a: TireActor, at: { lat: number; lng: number; count?: number | null; side?: "left" | "right" | null }, now = Date.now()): TirePileView => {
  if (!a.crew && !a.truck && !greenAt(a)) throw new TRPCError({ code: "FORBIDDEN", message: "Not allowed" });
  const row = db
    .insert(tirePiles)
    .values({
      eventId: a.event.id,
      dayId: a.day.id,
      ccId: a.cc.id,
      lat: at.lat,
      lng: at.lng,
      role: a.crew ? "crew" : a.truck ? "driver" : a.session.role === "admin" ? "admin" : "green",
      crewId: a.crew?.id ?? null,
      truckId: a.truck?.id ?? null,
      madeBy: a.crew ? crewLabel(a.crew) : a.truck ? a.truck.name : (a.session.displayName ?? "Green shirt"),
      sessionId: a.session.id,
      createdAt: now,
      count: at.count ?? null,
      side: at.side ?? null,
    })
    .returning()
    .get();
  emit(row);
  return view(a, row);
};

export const movePile = (a: TireActor, id: number, at: { lat: number; lng: number }, now = Date.now()): TirePileView => {
  const p = pileAt(a, id);
  if (!greenAt(a)) throw new TRPCError({ code: "FORBIDDEN", message: "Not allowed" });
  const row = db.update(tirePiles).set({ lat: at.lat, lng: at.lng, movedAt: now }).where(eq(tirePiles.id, p.id)).returning().get();
  emit(row);
  return view(a, row);
};

/** The tire count: the maker or a green shirt. */
export const setPileCount = (a: TireActor, id: number, count: number | null): TirePileView => {
  const p = pileAt(a, id);
  if (!view(a, p).canDelete) throw new TRPCError({ code: "FORBIDDEN", message: "Not allowed" });
  const row = db.update(tirePiles).set({ count }).where(eq(tirePiles.id, p.id)).returning().get();
  emit(row);
  return view(a, row);
};

export const deletePile = (a: TireActor, id: number): { id: number } => {
  const p = pileAt(a, id);
  if (!view(a, p).canDelete) throw new TRPCError({ code: "FORBIDDEN", message: "Not this crew's or truck's pile" });
  db.delete(tirePiles).where(eq(tirePiles.id, p.id)).run();
  removeTireFiles(p.id);
  emit(p, true);
  return { id: p.id };
};
// #endregion

// #region http
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, error: string): Response => json({ ok: false, error }, status);

/** True when the session holds green powers at the pile's CC (SPEC 27), or is admin. */
const canPhotographPile = (session: Session, pile: TirePile): boolean => {
  if (isAdminSession(session)) return true;
  if (session.role === "green") return session.ccId === pile.ccId;
  return holdsGreen(session.userId, pile.ccId);
};

/**
 * `POST /tire-photos`, multipart: `pileId`, `photo` and `thumb` (JPEG, 6 MB each at most). Green
 * shirts take it in Wrap up (SPEC 29). A new photo replaces the old one. Emits `tire.changed`.
 */
export const handleTirePhotoUpload = async (req: Request, now = Date.now()): Promise<Response> => {
  const session = getSession(sessionIdFrom(req));
  if (!session) return refuse(401, "Sign in");
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > 2 * MAX_PHOTO_BYTES + 64 * 1024) return refuse(413, "Photo over 6 MB");
  const form = await req.formData().catch(() => null);
  if (!form) return refuse(400, "No photo");
  const rawId = form.get("pileId");
  const pileId = typeof rawId === "string" && /^\d+$/.test(rawId) ? Number(rawId) : null;
  if (pileId === null) return refuse(400, "No tire pile");
  const pile = db.select().from(tirePiles).where(eq(tirePiles.id, pileId)).get();
  if (!pile) return refuse(404, "Tire pile not found");
  if (!canPhotographPile(session, pile)) return refuse(403, "Not allowed");
  const photo = form.get("photo");
  const thumb = form.get("thumb");
  if (!(photo instanceof Blob) || !(thumb instanceof Blob)) return refuse(400, "No photo");
  if (photo.size > MAX_PHOTO_BYTES || thumb.size > MAX_PHOTO_BYTES) return refuse(413, "Photo over 6 MB");
  const full = new Uint8Array(await photo.arrayBuffer());
  const small = new Uint8Array(await thumb.arrayBuffer());
  if (!jpegSize(full) || !isJpeg(small)) return refuse(400, "Photo not a JPEG");
  try {
    await Bun.write(tirePhotoPath(pile.id), full);
    await Bun.write(tirePhotoPath(pile.id, true), small);
  } catch (err) {
    console.error("[tires] write failed:", err instanceof Error ? err.message : String(err));
    return refuse(500, "Photo not saved. Try again.");
  }
  // The pile may have been deleted while the files were written.
  const row = db.update(tirePiles).set({ photoAt: now, photoBy: session.displayName }).where(eq(tirePiles.id, pile.id)).returning().get();
  if (!row) {
    removeTireFiles(pile.id);
    return refuse(404, "Tire pile not found");
  }
  emit(row);
  return json({ ok: true, photo: { id: row.id, pileId: row.id, at: now } });
};

/** `GET /tire-photos/<pile id>[/thumb]`, for every session of the pile's event. */
export const serveTirePhoto = async (req: Request, id: number, thumb: boolean): Promise<Response> => {
  const session = getSession(sessionIdFrom(req));
  const scope = session ? photoScope(session) : null;
  if (!scope) return new Response("Sign in", { status: 401 });
  const row = db
    .select({ photoAt: tirePiles.photoAt, eventId: tirePiles.eventId })
    .from(tirePiles)
    .where(eq(tirePiles.id, id))
    .get();
  if (!row || row.photoAt === null || (scope.role !== "admin" && scope.eventId !== row.eventId)) return new Response("Not found", { status: 404 });
  const file = Bun.file(tirePhotoPath(id, thumb));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  // The URL carries `?v=<photo_at>`, so a new photo is a new URL and the old one can stay cached.
  return new Response(file, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000" } });
};
// #endregion
