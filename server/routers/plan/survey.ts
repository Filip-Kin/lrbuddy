import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { assignments, parcels, surveyTags, SURVEY_GRADES, SURVEY_SIDES } from "../../db/schema.ts";
import { normalizeBBox } from "../../geo.ts";
import { cachedParcelsInBBox, loadParcelsBBox, newestTags, parcelsById, parcelsNear } from "../../parcels.ts";
import { adminProcedure, router } from "../../trpc.ts";
import { badRequest, bboxInput, dayOfEvent, eventInput, eventOrActive, id, notFound } from "./common.ts";

/** Largest rectangle Load parcels takes, in degrees per side (about 5 km). */
const MAX_LOAD_DEG = 0.06;

// #region parcels
export const parcelsRouter = router({
  /** Pulls every parcel in the rectangle from the assessor layer into the cache. */
  loadBbox: adminProcedure.input(z.object({ bbox: bboxInput })).mutation(async ({ input }) => {
    const [w, s, e, n] = normalizeBBox(input.bbox);
    if (e - w > MAX_LOAD_DEG || n - s > MAX_LOAD_DEG) throw badRequest("Area too large");
    try {
      return await loadParcelsBBox([w, s, e, n]);
    } catch (err) {
      throw new TRPCError({ code: "BAD_GATEWAY", message: "Parcel layer unavailable", cause: err });
    }
  }),
  /** Cached parcels in the rectangle with outlines and the event's newest grade. */
  inBbox: adminProcedure
    .input(z.object({ bbox: bboxInput, limit: z.number().int().min(1).max(8000).optional(), ...eventInput }))
    .query(({ input }) => {
      const eventId = eventOrActive(input.eventId);
      const limit = input.limit ?? 4000;
      const rows = cachedParcelsInBBox(input.bbox, limit + 1);
      const list = rows.slice(0, limit);
      const tags = newestTags(eventId, list.map((p) => p.parcelId));
      return {
        truncated: rows.length > limit,
        parcels: list.map((p) => {
          const t = tags.get(p.parcelId);
          return {
            parcelId: p.parcelId,
            address: p.address,
            lat: p.lat,
            lng: p.lng,
            geometry: p.geometry,
            blockSideKey: p.blockSideKey,
            propertyClassDescription: p.propertyClassDescription,
            isImproved: p.isImproved,
            grade: t?.grade ?? null,
            tagId: t?.id ?? null,
            taggedAt: t?.at ?? null,
            taggedBy: t?.by ?? null,
          };
        }),
      };
    }),
  /** How many parcels the cache holds, and when the newest was fetched. */
  stats: adminProcedure.query(() => {
    const row = db.select({ n: sql<number>`count(*)`, at: sql<number | null>`max(${parcels.fetchedAt})` }).from(parcels).get();
    return { count: row?.n ?? 0, fetchedAt: row?.at ?? null };
  }),
});
// #endregion

// #region survey
export const surveyRouter = router({
  /**
   * Newest tag per surveyed parcel, newest first, with the parcel's address
   * and outline. With `dayId`, only parcels on block sides assigned to that day.
   */
  list: adminProcedure.input(z.object({ dayId: id.nullish(), ...eventInput }).optional()).query(({ input }) => {
    const eventId = eventOrActive(input?.eventId);
    const tags = newestTags(eventId);
    const cache = new Map(parcelsById([...tags.keys()]).map((p) => [p.parcelId, p]));
    let keys: Set<string> | null = null;
    if (input?.dayId != null) {
      dayOfEvent(input.dayId, eventId);
      keys = new Set(
        db
          .select({ key: assignments.blockSideKey })
          .from(assignments)
          .where(and(eq(assignments.eventId, eventId), eq(assignments.dayId, input.dayId)))
          .all()
          .map((a) => a.key),
      );
    }
    const out = [];
    for (const t of tags.values()) {
      const p = cache.get(t.parcelId);
      if (keys && (!p?.blockSideKey || !keys.has(p.blockSideKey))) continue;
      out.push({
        tagId: t.id,
        parcelId: t.parcelId,
        grade: t.grade,
        side: t.side,
        note: t.note,
        by: t.by,
        at: t.at,
        address: p?.address ?? null,
        lat: p?.lat ?? t.lat,
        lng: p?.lng ?? t.lng,
        geometry: p?.geometry ?? null,
        blockSideKey: p?.blockSideKey ?? null,
      });
    }
    return out.sort((a, b) => b.at - a.at || b.tagId - a.tagId);
  }),
  /** Every tag on one parcel, newest first. */
  history: adminProcedure.input(z.object({ parcelId: z.string().min(1).max(40), ...eventInput })).query(({ input }) =>
    db
      .select()
      .from(surveyTags)
      .where(and(eq(surveyTags.eventId, eventOrActive(input.eventId)), eq(surveyTags.parcelId, input.parcelId)))
      .orderBy(desc(surveyTags.at), desc(surveyTags.id))
      .all(),
  ),
  /** Adds a tag; the newest tag per parcel wins, and `clear` takes the parcel off the work list. */
  tag: adminProcedure
    .input(
      z.object({
        parcelId: z.string().min(1).max(40),
        grade: z.enum(SURVEY_GRADES),
        side: z.enum(SURVEY_SIDES).default("tap"),
        note: z.string().trim().max(500).nullish(),
        lat: z.number().min(-90).max(90).nullish(),
        lng: z.number().min(-180).max(180).nullish(),
        heading: z.number().nullish(),
        /** When the tap happened; queued drive-mode tags post late. */
        at: z.number().int().positive().optional(),
        ...eventInput,
      }),
    )
    .mutation(({ ctx, input }) => {
      const eventId = eventOrActive(input.eventId);
      const p = db.select({ parcelId: parcels.parcelId, address: parcels.address }).from(parcels).where(eq(parcels.parcelId, input.parcelId)).get();
      if (!p) throw notFound("Parcel");
      const now = Date.now();
      const tag = db
        .insert(surveyTags)
        .values({
          eventId,
          parcelId: p.parcelId,
          grade: input.grade,
          side: input.side,
          note: input.note || null,
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          heading: input.heading ?? null,
          by: ctx.session.displayName ?? "Admin",
          at: Math.min(input.at ?? now, now),
        })
        .returning()
        .get();
      return { tag, address: p.address };
    }),
  /** Removes one tag (drive mode Undo); the parcel falls back to its previous tag. */
  undo: adminProcedure.input(z.object({ id })).mutation(({ input }) => {
    const r = db.delete(surveyTags).where(eq(surveyTags.id, input.id)).returning({ id: surveyTags.id }).get();
    if (!r) throw notFound("Tag");
    return { ok: true };
  }),
  /** Cached parcels near a point for drive mode, nearest first, with the newest grade. */
  near: adminProcedure
    .input(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), radiusM: z.number().min(5).max(300).default(80), ...eventInput }))
    .query(({ input }) => {
      const eventId = eventOrActive(input.eventId);
      const rows = parcelsNear(input, input.radiusM);
      const tags = newestTags(eventId, rows.map((r) => r.parcelId));
      return rows.map((r) => ({
        parcelId: r.parcelId,
        address: r.address,
        lat: r.lat,
        lng: r.lng,
        geometry: r.geometry,
        blockSideKey: r.blockSideKey,
        streetName: r.streetName,
        streetNumber: r.streetNumber,
        propertyClassDescription: r.propertyClassDescription,
        distanceM: Math.round(r.distanceM),
        grade: tags.get(r.parcelId)?.grade ?? null,
      }));
    }),
});
// #endregion
