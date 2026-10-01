import { and, eq, inArray } from "drizzle-orm";
import QRCode from "qrcode";
import { z } from "zod";
import { config } from "../../config.ts";
import { db } from "../../db/index.ts";
import { commandCenters, companies, crews, events, greenCodes, greenShirts, lots, trucks, type AreaPolygon, type Lot } from "../../db/schema.ts";
import { crewLabel } from "../../dispatch.ts";
import { bboxOf, type BBox } from "../../geo.ts";
import { newestTags, outlinePoints } from "../../parcels.ts";
import { siteCcIds } from "../../queries.ts";
import { adminProcedure, router } from "../../trpc.ts";
import { dayOfEvent, eventInput, eventOrActive, id, teamNames } from "./common.ts";

const areaPoints = (a: AreaPolygon): Array<{ lat: number; lng: number }> => outlinePoints(a);

const lotView = (l: Lot, grade: "high" | "low" | "clear" | null) => ({
  id: l.id,
  address: l.address,
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
    const names = teamNames(day.id);
    const crewIds = new Set(crewRows.map((r) => r.crew.id));

    // Lots of every CC site on this day, with their newest survey grade.
    const siteOf = new Map(ccs.map((c) => [c.id, siteCcIds(c.id)]));
    const allSiteIds = [...new Set([...siteOf.values()].flat())];
    const lotRows = allSiteIds.length ? db.select().from(lots).where(and(eq(lots.eventId, eventId), inArray(lots.ccId, allSiteIds))).all() : [];
    const crewLots = crewIds.size ? db.select().from(lots).where(and(eq(lots.eventId, eventId), inArray(lots.crewId, [...crewIds]))).all() : [];
    const grades = newestTags(eventId, [...lotRows, ...crewLots].map((l) => l.parcelId).filter((p): p is string => p !== null));
    const gradeOf = (l: Lot) => (l.parcelId ? (grades.get(l.parcelId)?.grade ?? null) : null);

    const areas = crewRows.map(({ crew }) => ({ crewId: crew.id, ccId: crew.ccId, name: names.get(crew.id) ?? crewLabel(crew), area: crew.area }));
    const loginUrl = `${config.publicUrl}/login`;
    const loginQrSvg = await QRCode.toString(loginUrl, { type: "svg", margin: 1 });

    const ccPages = ccs.map((cc) => {
      const site = new Set(siteOf.get(cc.id) ?? [cc.id]);
      const work = lotRows.filter((l) => l.ccId !== null && site.has(l.ccId) && (l.status === "open" || l.status === "in_progress"));
      const ccAreas = areas.filter((a) => a.ccId === cc.id);
      const pts = [{ lat: cc.lat, lng: cc.lng }, ...work, ...ccAreas.flatMap((a) => (a.area ? areaPoints(a.area) : []))];
      const bounds: BBox = bboxOf(pts) ?? [cc.lng, cc.lat, cc.lng, cc.lat];
      return {
        ccId: cc.id,
        name: cc.name,
        address: cc.address,
        lat: cc.lat,
        lng: cc.lng,
        bounds,
        greenCode: codes.find((g) => g.ccId === cc.id)?.code ?? null,
        loginUrl,
        loginQrSvg,
        trucks: truckRows.filter((t) => t.ccId === cc.id).map((t) => ({ name: t.name, driverName: t.driverName, code: t.code })),
        greenShirts: shirts.filter((g) => g.ccId === cc.id).map((g) => ({ name: g.name, phone: g.phone, roleLabel: g.roleLabel })),
        crews: crewRows
          .filter((r) => r.crew.ccId === cc.id)
          .map(({ crew, company }) => ({
            crewId: crew.id,
            name: crewLabel(crew),
            teamName: names.get(crew.id) ?? crewLabel(crew),
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
          teamName: names.get(crew.id) ?? crewLabel(crew),
          companyName: company?.name ?? null,
          leadName: crew.leadName,
          leadPhone: crew.leadPhone,
          ccId: crew.ccId,
          ccName: cc?.name ?? null,
          ccAddress: cc?.address ?? null,
          cc: cc ? { lat: cc.lat, lng: cc.lng } : null,
          url,
          qrSvg: await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }),
          area: crew.area,
          lots: mine.map((l) => lotView(l, gradeOf(l))),
          otherAreas: areas.filter((a) => a.ccId === crew.ccId && a.crewId !== crew.id),
          greenShirts: shirts.filter((g) => g.ccId === crew.ccId).map((g) => ({ name: g.name, phone: g.phone, roleLabel: g.roleLabel })),
        };
      }),
    );
    return { event: event ? { id: event.id, name: event.name } : null, day, crewPages, ccPages };
  }),
});
