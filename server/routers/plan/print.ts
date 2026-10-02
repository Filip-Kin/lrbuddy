import { and, eq, inArray } from "drizzle-orm";
import QRCode from "qrcode";
import { z } from "zod";
import { config } from "../../config.ts";
import { db } from "../../db/index.ts";
import { commandCenters, companies, crews, events, greenCodes, greenShirts, lots, trucks, type AreaPolygon, type Lot } from "../../db/schema.ts";
import { shortOf } from "../../crew-name.ts";
import { crewLabel } from "../../dispatch.ts";
import { bboxOf, padBBox, type BBox } from "../../geo.ts";
import { newestTags, outlinePoints } from "../../parcels.ts";
import { siteCcIds } from "../../queries.ts";
import { adminProcedure, router } from "../../trpc.ts";
import { dayAreas } from "./areas.ts";
import { convexHull, type Ring } from "./blocks.ts";
import { dayOfEvent, eventInput, eventOrActive, id } from "./common.ts";

const areaPoints = (a: AreaPolygon): Array<{ lat: number; lng: number }> => outlinePoints(a);

/** Metres the tinted day area reaches past the crew areas (SPEC 19). */
export const DAY_AREA_PAD_M = 60;

/**
 * An area grown by `m` metres all round: the hull of a circle of points
 * around each corner. Rings come out counter-clockwise, all the same way, so
 * a nonzero fill draws several as one union.
 */
export const padRing = (ring: ReadonlyArray<readonly number[]>, m: number): Ring => {
  const pts: Array<[number, number]> = [];
  for (const p of ring) {
    const lng = p[0];
    const lat = p[1];
    if (lng === undefined || lat === undefined) continue;
    const dLat = m / 111320;
    const dLng = m / (111320 * Math.cos((lat * Math.PI) / 180));
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8;
      pts.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
    }
  }
  return convexHull(pts);
};

const lotView = (l: Lot, grade: "high" | "low" | "clear" | null) => ({
  id: l.id,
  address: l.address,
  parcelId: l.parcelId,
  lat: l.lat,
  lng: l.lng,
  geometry: l.geometry,
  status: l.status,
  crewId: l.crewId,
  grade,
});

export const printRouter = router({
  /**
   * Everything /plan/print draws for a day: per crew its header, QR, area,
   * lots with grade, the CC and the other crews' areas at that CC; per CC its
   * codes, trucks, crews, every lot still needing work and the bounds to fit.
   */
  sheets: adminProcedure.input(z.object({ dayId: id, ...eventInput })).query(async ({ input }) => {
    const eventId = eventOrActive(input.eventId);
    const day = dayOfEvent(input.dayId, eventId);
    const event = db.select().from(events).where(eq(events.id, eventId)).get();
    const ccs = db.select().from(commandCenters).where(eq(commandCenters.dayId, day.id)).orderBy(commandCenters.name).all();
    const ccIds = ccs.map((c) => c.id);
    const shirts = ccIds.length ? db.select().from(greenShirts).where(inArray(greenShirts.ccId, ccIds)).orderBy(greenShirts.id).all() : [];
    const codes = ccIds.length ? db.select().from(greenCodes).where(inArray(greenCodes.ccId, ccIds)).all() : [];
    const truckRows = db.select().from(trucks).where(eq(trucks.dayId, day.id)).orderBy(trucks.name).all();
    const crewRows = db
      .select({ crew: crews, company: companies })
      .from(crews)
      .leftJoin(companies, eq(companies.id, crews.companyId))
      .where(eq(crews.dayId, day.id))
      .orderBy(crews.number)
      .all();
    const crewIds = new Set(crewRows.map((r) => r.crew.id));

    // Lots of every CC site on this day, with their newest survey grade.
    const siteOf = new Map(ccs.map((c) => [c.id, siteCcIds(c.id)]));
    const allSiteIds = [...new Set([...siteOf.values()].flat())];
    const lotRows = allSiteIds.length ? db.select().from(lots).where(and(eq(lots.eventId, eventId), inArray(lots.ccId, allSiteIds))).all() : [];
    // Not todo lots are not work (SPEC 21) and never print.
    const crewLots = crewIds.size
      ? db.select().from(lots).where(and(eq(lots.eventId, eventId), inArray(lots.crewId, [...crewIds]))).all().filter((l) => l.status !== "not_todo")
      : [];
    const grades = newestTags(eventId, [...lotRows, ...crewLots].map((l) => l.parcelId).filter((p): p is string => p !== null));
    // The lot's own grade (SPEC 21), else the parcel's newest survey grade.
    const gradeOf = (l: Lot) => l.grade ?? (l.parcelId ? (grades.get(l.parcelId)?.grade ?? null) : null);

    // One entry per area, shared or not, labelled the way the sheets print it.
    const areas = dayAreas(day.id)
      .filter((a): a is typeof a & { polygon: AreaPolygon } => a.polygon !== null && a.ccId !== null)
      .map((a) => ({ areaId: a.id, ccId: a.ccId ?? 0, companyId: a.companyId, crewIds: a.crewIds, name: a.label, area: a.polygon, doNotTouch: a.doNotTouch }));
    const areaOfCrew = new Map(areas.flatMap((a) => a.crewIds.map((c) => [c, a] as const)));
    const loginUrl = `${config.publicUrl}/login`;
    const loginQrSvg = await QRCode.toString(loginUrl, { type: "svg", margin: 1 });

    const qr = (url: string): Promise<string> => QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    // SPEC 18: drivers and greens scan in too. `/t/<truck code>` and `/g/<green code>` on the CC sheet.
    const truckQrs = new Map(await Promise.all(truckRows.map(async (t) => [t.id, await qr(`${config.publicUrl}/t/${t.code}`)] as const)));
    const greenQrs = new Map(await Promise.all(codes.map(async (g) => [g.ccId, await qr(`${config.publicUrl}/g/${g.code}`)] as const)));

    const ccPages = ccs.map((cc) => {
      const site = new Set(siteOf.get(cc.id) ?? [cc.id]);
      // Lots still to do, and Do not touch lots, which print hatched (SPEC 21).
      const work = lotRows.filter((l) => l.ccId !== null && site.has(l.ccId) && (l.status === "open" || l.status === "in_progress" || l.status === "not_done" || l.status === "do_not_touch"));
      const ccAreas = areas.filter((a) => a.ccId === cc.id);
      const pts = [{ lat: cc.lat, lng: cc.lng }, ...work, ...ccAreas.flatMap((a) => areaPoints(a.area))];
      const bounds: BBox = bboxOf(pts) ?? [cc.lng, cc.lat, cc.lng, cc.lat];
      // SPEC 19: the day's area is every crew area at the CC, else the work lots' box, padded 60 m.
      const lotBox = bboxOf(work);
      const dayArea: Ring[] = ccAreas.length
        ? ccAreas.map((a) => padRing(a.area.coordinates[0] ?? [], DAY_AREA_PAD_M))
        : lotBox
          ? [padRing([[lotBox[0], lotBox[1]], [lotBox[2], lotBox[1]], [lotBox[2], lotBox[3]], [lotBox[0], lotBox[3]]], DAY_AREA_PAD_M)]
          : [];
      const dayPts = dayArea.flat().map(([lng, lat]) => ({ lat, lng }));
      const dayBounds: BBox = bboxOf([{ lat: cc.lat, lng: cc.lng }, ...dayPts]) ?? padBBox([cc.lng, cc.lat, cc.lng, cc.lat], 300);
      return {
        ccId: cc.id,
        name: cc.name,
        letter: cc.letter,
        address: cc.address,
        dayArea,
        dayBounds,
        lat: cc.lat,
        lng: cc.lng,
        bounds,
        greenCode: codes.find((g) => g.ccId === cc.id)?.code ?? null,
        greenQrSvg: greenQrs.get(cc.id) ?? null,
        loginUrl,
        loginQrSvg,
        trucks: truckRows
          .filter((t) => t.ccId === cc.id)
          .map((t) => ({ name: t.name, driverName: t.driverName, code: t.code, qrSvg: truckQrs.get(t.id) ?? null })),
        greenShirts: shirts.filter((g) => g.ccId === cc.id).map((g) => ({ name: g.name, phone: g.phone, roleLabel: g.roleLabel })),
        crews: crewRows
          .filter((r) => r.crew.ccId === cc.id)
          .map(({ crew, company }) => ({
            crewId: crew.id,
            name: crewLabel(crew),
            companyName: company?.name ?? null,
            leadName: crew.leadName,
            leadPhone: crew.leadPhone,
            headcount: crew.headcount,
            lotCount: crewLots.filter((l) => l.crewId === crew.id).length,
          })),
        areas: ccAreas,
        workLots: work.map((l) => lotView(l, gradeOf(l))),
      };
    });

    const crewPages = await Promise.all(
      crewRows.map(async ({ crew, company }) => {
        const url = `${config.publicUrl}/j/${crew.token}`;
        const cc = ccs.find((c) => c.id === crew.ccId) ?? null;
        const mine = crewLots.filter((l) => l.crewId === crew.id).sort((a, b) => (a.address ?? "").localeCompare(b.address ?? "", "en", { numeric: true }));
        return {
          crewId: crew.id,
          name: crewLabel(crew),
          companyName: company?.name ?? null,
          leadName: crew.leadName,
          leadPhone: crew.leadPhone,
          ccId: crew.ccId,
          ccName: cc?.name ?? null,
          ccLetter: cc?.letter ?? null,
          ccAddress: cc?.address ?? null,
          cc: cc ? { lat: cc.lat, lng: cc.lng } : null,
          url,
          /** The crew token, typed at /login when the QR will not scan. */
          code: crew.token,
          loginUrl,
          qrSvg: await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }),
          area: areaOfCrew.get(crew.id)?.area ?? null,
          /** The name on the crew's rectangle; a shared area names every crew in it. */
          areaName: areaOfCrew.get(crew.id)?.name ?? null,
          /** Marked Do not touch in the field: the sheets draw it hatched. */
          areaDoNotTouch: areaOfCrew.get(crew.id)?.doNotTouch ?? false,
          lots: mine.map((l) => lotView(l, gradeOf(l))),
          otherAreas: areas.filter((a) => a.ccId === crew.ccId && a.areaId !== areaOfCrew.get(crew.id)?.areaId),
          greenShirts: shirts.filter((g) => g.ccId === crew.ccId).map((g) => ({ name: g.name, phone: g.phone, roleLabel: g.roleLabel })),
        };
      }),
    );

    // SPEC 19: one landscape sheet per company per CC: legend with headcounts, the company's areas on the CC's map.
    const companyPages = ccs.flatMap((cc) => {
      const here = crewRows.filter((r) => r.crew.ccId === cc.id && r.company !== null);
      const byCompany = new Map<number, typeof here>();
      for (const r of here) byCompany.set(r.company!.id, [...(byCompany.get(r.company!.id) ?? []), r]);
      return [...byCompany.values()]
        .sort((a, b) => a[0]!.company!.name.localeCompare(b[0]!.company!.name))
        .map((list) => {
          const company = list[0]!.company!;
          const headcount = list.reduce((n, r) => n + (r.crew.headcount ?? 0), 0);
          return {
            key: `company-${cc.id}-${company.id}`,
            ccId: cc.id,
            companyId: company.id,
            companyName: company.name,
            short: shortOf(company),
            headcount,
            crews: list.map(({ crew }) => ({ crewId: crew.id, name: crewLabel(crew), headcount: crew.headcount })),
            areaIds: [...new Set(list.map(({ crew }) => areaOfCrew.get(crew.id)?.areaId).filter((x): x is number => x !== undefined))],
          };
        });
    });
    return { event: event ? { id: event.id, name: event.name } : null, day, companyPages, crewPages, ccPages };
  }),
});
