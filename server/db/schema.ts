import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// #region enums
export const ROLES = ["admin", "green", "driver", "crew"] as const;
export type Role = (typeof ROLES)[number];
/** A session's role: one of ROLES, or `none` for a signed-in user with no role yet (SPEC 18). */
export const SESSION_ROLES = [...ROLES, "none"] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

export const TRUCK_STATUSES = ["idle", "delivering", "returning", "offline"] as const;
export type TruckStatus = (typeof TRUCK_STATUSES)[number];

export const UNITS = ["case", "box", "can", "each", "roll"] as const;
export type Unit = (typeof UNITS)[number];

export const REQUEST_STATUSES = ["open", "assigned", "en_route", "delivered", "cancelled"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const REQUEST_CREATORS = ["crew", "green"] as const;
export const CANCELLERS = ["crew", "green", "driver"] as const;
export type Canceller = (typeof CANCELLERS)[number];

export const STOCK_REASONS = ["delivery", "restock", "adjust"] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

export const POSITION_KINDS = ["crew", "truck"] as const;
export type PositionKind = (typeof POSITION_KINDS)[number];

/** `drawn`: a shape a green or admin drew on the map for an alley or an odd space (SPEC 24). */
export const LOT_SOURCES = ["dlba", "parcel", "csv", "manual", "survey", "drawn"] as const;
export type LotSource = (typeof LOT_SOURCES)[number];

/**
 * SPEC 21: open is "Todo"; a parcel with no lot row is "Not todo", and `not_todo`
 * is a reverted todo that keeps its history (photos, status trail).
 */
export const LOT_STATUSES = ["open", "in_progress", "done", "do_not_touch", "not_todo"] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];

/** Optional work size on a todo lot (SPEC 21): high is "Full day", low is "Light". */
export const LOT_GRADES = ["high", "low"] as const;
export type LotGrade = (typeof LOT_GRADES)[number];

export const PHOTO_KINDS = ["before", "after"] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

export const SURVEY_GRADES = ["high", "low", "clear"] as const;
export type SurveyGrade = (typeof SURVEY_GRADES)[number];

export const SURVEY_SIDES = ["left", "right", "tap"] as const;
export type SurveySide = (typeof SURVEY_SIDES)[number];

export const MEMBERSHIP_STATUSES = ["pending", "approved", "denied"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const ROUTE_ENGINES = ["osrm", "fallback"] as const;
export type RouteEngine = (typeof ROUTE_ENGINES)[number];
// #endregion

// #region json shapes
/** One stop on a computed route, in visit order. */
export interface RouteLeg {
  /** `crew:<id>` for a crew stop, `req:<id>` for a crewless request, `cc` for the return leg. */
  key: string;
  crewId: number | null;
  requestIds: number[];
  lat: number;
  lng: number;
  /** Seconds from the origin to this stop, cumulative. */
  etaS: number;
  /** Metres from the origin to this stop, cumulative. */
  distanceM: number;
  /** Turns on the way to this stop from the one before, from OSRM. Absent when the fallback routed the leg. */
  steps?: Manoeuvre[];
}

/** One OSRM manoeuvre on a leg: where it is and what the driver does there. */
export interface Manoeuvre {
  /** OSRM maneuver type: turn, end of road, fork, merge, roundabout, arrive... */
  type: string;
  /** left, slight left, sharp left, right, ..., straight, uturn; null when OSRM gives none. */
  modifier: string | null;
  /** Street taken at the manoeuvre ("Harding Street"), else its ref, else "". */
  name: string;
  lat: number;
  lng: number;
  /** Metres from the start of the leg to the manoeuvre. */
  atM: number;
}

/** Parcel outline in WGS84, as the city parcel layer returns it. */
export type LotGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };
/** A crew's printed work area: a closed ring in WGS84, possibly rotated. */
export type AreaPolygon = { type: "Polygon"; coordinates: number[][][] };
// #endregion

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  year: integer("year").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(false),
});

export const days = sqliteTable(
  "days",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    label: text("label").notNull(),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("days_event_idx").on(t.eventId)],
);

export const commandCenters = sqliteTable(
  "command_centers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    dayId: integer("day_id")
      .notNull()
      .references(() => days.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    address: text("address"),
    notes: text("notes"),
    /** The CC's letter for the day ("A", "B"), drawn in its map marker and on the sheets (SPEC 19). */
    letter: text("letter"),
  },
  (t) => [index("cc_day_idx").on(t.dayId)],
);

export const greenShirts = sqliteTable(
  "green_shirts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ccId: integer("cc_id")
      .notNull()
      .references(() => commandCenters.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone"),
    roleLabel: text("role_label"),
  },
  (t) => [index("green_shirts_cc_idx").on(t.ccId)],
);

export const companies = sqliteTable(
  "companies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Abbreviation for crew names ("GM" makes "GM 1"); null falls back to the first word of the name. */
    short: text("short"),
  },
  (t) => [index("companies_event_idx").on(t.eventId)],
);

/**
 * A printed work area (SPEC 19): one rectangle shared by one or more crews of a
 * day. `polygon` is null until Publish or a drag sets it; `label` overrides the
 * crews' names joined ("GM 9, GM 10 & GM 11") and is normally null.
 * `doNotTouch` is the sharpie X (SPEC 19 Marks): maps and sheets draw the area hatched.
 */
export const crewAreas = sqliteTable(
  "crew_areas",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    dayId: integer("day_id")
      .notNull()
      .references(() => days.id, { onDelete: "cascade" }),
    polygon: text("polygon", { mode: "json" }).$type<AreaPolygon>(),
    label: text("label"),
    doNotTouch: integer("do_not_touch", { mode: "boolean" }),
  },
  (t) => [index("crew_areas_day_idx").on(t.dayId)],
);

export const crews = sqliteTable(
  "crews",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    dayId: integer("day_id")
      .notNull()
      .references(() => days.id, { onDelete: "cascade" }),
    ccId: integer("cc_id")
      .notNull()
      .references(() => commandCenters.id, { onDelete: "cascade" }),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "set null" }),
    /** Crew number within the day: orders crews and names a crew without a company. */
    number: integer("number").notNull(),
    /** The crew's name everywhere it is shown, "GM 2" or "Crew 7" (SPEC 19, `server/crew-name.ts`). */
    name: text("name").notNull(),
    leadName: text("lead_name"),
    leadPhone: text("lead_phone"),
    token: text("token").notNull().unique(),
    headcount: integer("headcount"),
    notes: text("notes"),
    lastSeenAt: integer("last_seen_at"),
    /** The crew's printed area, possibly shared with other crews (SPEC 19); null until Publish or a drag sets it. */
    areaId: integer("area_id").references(() => crewAreas.id, { onDelete: "set null" }),
  },
  (t) => [index("crews_day_idx").on(t.dayId), index("crews_cc_idx").on(t.ccId)],
);

export const trucks = sqliteTable(
  "trucks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    dayId: integer("day_id")
      .notNull()
      .references(() => days.id, { onDelete: "cascade" }),
    ccId: integer("cc_id")
      .notNull()
      .references(() => commandCenters.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    driverName: text("driver_name"),
    driverPhone: text("driver_phone"),
    code: text("code").notNull().unique(),
    status: text("status", { enum: TRUCK_STATUSES }).notNull().default("idle"),
    lastSeenAt: integer("last_seen_at"),
    /** Stop key the driver chose as next; the route visits it first until it is delivered or leaves the truck. */
    pinnedStopKey: text("pinned_stop_key"),
  },
  (t) => [index("trucks_cc_idx").on(t.ccId)],
);

export const greenCodes = sqliteTable("green_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ccId: integer("cc_id")
    .notNull()
    .unique()
    .references(() => commandCenters.id, { onDelete: "cascade" }),
  code: text("code").notNull().unique(),
});

/** A person signed in through Firebase (SPEC 18). Code and password sessions have no user. */
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  firebaseUid: text("firebase_uid").notNull().unique(),
  name: text("name"),
  /** E.164, from the phone sign-in. */
  phone: text("phone"),
  email: text("email"),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
});

/**
 * What a user may be: one role at one scope on one day. A QR scan creates it
 * approved; a request creates it pending until a green shirt or admin decides.
 */
export const memberships = sqliteTable(
  "memberships",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    role: text("role", { enum: ROLES }).notNull(),
    dayId: integer("day_id").references(() => days.id, { onDelete: "cascade" }),
    ccId: integer("cc_id").references(() => commandCenters.id, { onDelete: "cascade" }),
    crewId: integer("crew_id").references(() => crews.id, { onDelete: "cascade" }),
    truckId: integer("truck_id").references(() => trucks.id, { onDelete: "cascade" }),
    status: text("status", { enum: MEMBERSHIP_STATUSES }).notNull().default("pending"),
    requestedAt: integer("requested_at").notNull(),
    decidedAt: integer("decided_at"),
    decidedByUserId: integer("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
  },
  (t) => [index("memberships_user_idx").on(t.userId), index("memberships_cc_status_idx").on(t.ccId, t.status)],
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  role: text("role", { enum: SESSION_ROLES }).notNull(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  /** The membership this session is acting under; null for code and password sessions. */
  membershipId: integer("membership_id").references(() => memberships.id, { onDelete: "set null" }),
  crewId: integer("crew_id").references(() => crews.id, { onDelete: "cascade" }),
  truckId: integer("truck_id").references(() => trucks.id, { onDelete: "cascade" }),
  ccId: integer("cc_id").references(() => commandCenters.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at").notNull(),
  userAgent: text("user_agent"),
});

export const requestTypes = sqliteTable(
  "request_types",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    unit: text("unit", { enum: UNITS }).notNull(),
    /** 1 low, 2 normal, 3 urgent. */
    priority: integer("priority").notNull().default(2),
    tracksStock: integer("tracks_stock", { mode: "boolean" }).notNull().default(true),
    /** Stock capacity given to a new truck for this type. */
    defaultCapacity: integer("default_capacity").notNull().default(0),
    sort: integer("sort").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("request_types_event_key").on(t.eventId, t.key)],
);

export const requests = sqliteTable(
  "requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    crewId: integer("crew_id").references(() => crews.id, { onDelete: "cascade" }),
    ccId: integer("cc_id")
      .notNull()
      .references(() => commandCenters.id, { onDelete: "cascade" }),
    dayId: integer("day_id")
      .notNull()
      .references(() => days.id, { onDelete: "cascade" }),
    typeId: integer("type_id")
      .notNull()
      .references(() => requestTypes.id, { onDelete: "cascade" }),
    qty: integer("qty").notNull().default(1),
    note: text("note"),
    createdBy: text("created_by", { enum: REQUEST_CREATORS }).notNull(),
    label: text("label"),
    status: text("status", { enum: REQUEST_STATUSES }).notNull().default("open"),
    truckId: integer("truck_id").references(() => trucks.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    assignedAt: integer("assigned_at"),
    enRouteAt: integer("en_route_at"),
    deliveredAt: integer("delivered_at"),
    cancelledAt: integer("cancelled_at"),
    cancelledBy: text("cancelled_by", { enum: CANCELLERS }),
    /** Reason given when a driver cancels an en route request. */
    cancelNote: text("cancel_note"),
    lat: real("lat"),
    lng: real("lng"),
  },
  (t) => [
    index("requests_cc_day_idx").on(t.ccId, t.dayId),
    index("requests_truck_idx").on(t.truckId),
    index("requests_crew_idx").on(t.crewId),
  ],
);

export const truckStock = sqliteTable(
  "truck_stock",
  {
    truckId: integer("truck_id")
      .notNull()
      .references(() => trucks.id, { onDelete: "cascade" }),
    typeId: integer("type_id")
      .notNull()
      .references(() => requestTypes.id, { onDelete: "cascade" }),
    qty: integer("qty").notNull().default(0),
    capacity: integer("capacity").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.truckId, t.typeId] })],
);

export const stockMoves = sqliteTable(
  "stock_moves",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    truckId: integer("truck_id")
      .notNull()
      .references(() => trucks.id, { onDelete: "cascade" }),
    typeId: integer("type_id")
      .notNull()
      .references(() => requestTypes.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    reason: text("reason", { enum: STOCK_REASONS }).notNull(),
    requestId: integer("request_id").references(() => requests.id, { onDelete: "set null" }),
    at: integer("at").notNull(),
  },
  (t) => [index("stock_moves_truck_idx").on(t.truckId)],
);

export const positions = sqliteTable(
  "positions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: POSITION_KINDS }).notNull(),
    refId: integer("ref_id").notNull(),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    accuracy: real("accuracy"),
    heading: real("heading"),
    speed: real("speed"),
    at: integer("at").notNull(),
  },
  (t) => [index("positions_kind_ref_at").on(t.kind, t.refId, sql`${t.at} desc`)],
);

export const lots = sqliteTable(
  "lots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    parcelId: text("parcel_id"),
    address: text("address"),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    source: text("source", { enum: LOT_SOURCES }).notNull(),
    /** Parcel outline; null when the lot has no parcel match. */
    geometry: text("geometry", { mode: "json" }).$type<LotGeometry>(),
    ccId: integer("cc_id").references(() => commandCenters.id, { onDelete: "set null" }),
    crewId: integer("crew_id").references(() => crews.id, { onDelete: "set null" }),
    status: text("status", { enum: LOT_STATUSES }).notNull().default("open"),
    grade: text("grade", { enum: LOT_GRADES }),
    statusByCrewId: integer("status_by_crew_id").references(() => crews.id, { onDelete: "set null" }),
    statusAt: integer("status_at"),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("lots_event_parcel").on(t.eventId, t.parcelId).where(sql`parcel_id is not null`),
    index("lots_cc_idx").on(t.ccId),
    index("lots_crew_idx").on(t.crewId),
  ],
);

/**
 * Before and after photos of a lot. The JPEGs live at `$DATA_DIR/photos/<id>.jpg`
 * and `<id>.thumb.jpg`, never in the database. `session_id` names the session
 * that took it (no foreign key: the photo outlives a sign-out). CC and day
 * fall to null if an admin deletes that CC row, so the photo stays with its lot.
 */
export const lotPhotos = sqliteTable(
  "lot_photos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lotId: integer("lot_id")
      .notNull()
      .references(() => lots.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: PHOTO_KINDS }).notNull(),
    sessionId: text("session_id"),
    takenBy: text("taken_by"),
    role: text("role", { enum: ROLES }).notNull(),
    crewId: integer("crew_id").references(() => crews.id, { onDelete: "set null" }),
    truckId: integer("truck_id").references(() => trucks.id, { onDelete: "set null" }),
    ccId: integer("cc_id").references(() => commandCenters.id, { onDelete: "set null" }),
    dayId: integer("day_id").references(() => days.id, { onDelete: "set null" }),
    at: integer("at").notNull(),
    lat: real("lat"),
    lng: real("lng"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("lot_photos_lot_idx").on(t.lotId), index("lot_photos_day_cc_idx").on(t.dayId, t.ccId)],
);

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const broadcasts = sqliteTable(
  "broadcasts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ccId: integer("cc_id")
      .notNull()
      .references(() => commandCenters.id, { onDelete: "cascade" }),
    dayId: integer("day_id")
      .notNull()
      .references(() => days.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    sentBy: text("sent_by"),
    at: integer("at").notNull(),
  },
  (t) => [index("broadcasts_cc_idx").on(t.ccId)],
);

export const routes = sqliteTable("routes", {
  truckId: integer("truck_id")
    .primaryKey()
    .references(() => trucks.id, { onDelete: "cascade" }),
  computedAt: integer("computed_at").notNull(),
  /** Request ids in visit order. */
  stopOrder: text("stop_order", { mode: "json" }).$type<number[]>().notNull(),
  /** Polyline as [[lat, lng], ...]. */
  geometry: text("geometry", { mode: "json" }).$type<Array<[number, number]>>().notNull(),
  /** One entry per stop in visit order, with cumulative ETA. */
  legs: text("legs", { mode: "json" }).$type<RouteLeg[]>().notNull(),
  distanceM: real("distance_m").notNull(),
  durationS: real("duration_s").notNull(),
  endsAtCc: integer("ends_at_cc", { mode: "boolean" }).notNull().default(false),
  engine: text("engine", { enum: ROUTE_ENGINES }).notNull(),
  /** Where the truck was when this route was computed, to detect a 250 m move. */
  originLat: real("origin_lat").notNull(),
  originLng: real("origin_lng").notNull(),
});

// #region planning portal (SPEC 16)
/**
 * Cache of the city assessor's parcel layer for the areas the survey has
 * touched. Shared by every event; refreshed per bbox. `block_side_key` is
 * derived on write by `blockSideKey()` in server/parcels.ts.
 */
export const parcels = sqliteTable(
  "parcels",
  {
    parcelId: text("parcel_id").primaryKey(),
    address: text("address"),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    geometry: text("geometry", { mode: "json" }).$type<LotGeometry>().notNull(),
    streetName: text("street_name"),
    streetNumber: integer("street_number"),
    streetPrefix: text("street_prefix"),
    crossStreet1: text("cross_street_1"),
    crossStreet2: text("cross_street_2"),
    propertyClass: text("property_class"),
    propertyClassDescription: text("property_class_description"),
    taxpayer1: text("taxpayer_1"),
    isImproved: integer("is_improved", { mode: "boolean" }),
    pctPreClaimed: real("pct_pre_claimed"),
    /** YYYY-MM-DD as the layer gives it. */
    saleDate: text("sale_date"),
    blockSideKey: text("block_side_key"),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [index("parcels_lat_lng_idx").on(t.lat, t.lng), index("parcels_block_side_idx").on(t.blockSideKey)],
);

/**
 * One-way streets from OpenStreetMap (SPEC 20), cached per fetched bbox. One row per way and
 * bbox; the same way can sit under two keys. `direction` 1 runs in the order of `geometry`,
 * -1 against it (OSM `oneway=-1`). The bounds columns let a map ask for its view.
 */
export const onewayWays = sqliteTable(
  "oneway_ways",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bboxKey: text("bbox_key").notNull(),
    osmId: integer("osm_id").notNull(),
    /** [[lat, lng], ...] in the way's node order. */
    geometry: text("geometry", { mode: "json" }).$type<Array<[number, number]>>().notNull(),
    direction: integer("direction").notNull(),
    name: text("name"),
    minLat: real("min_lat").notNull(),
    minLng: real("min_lng").notNull(),
    maxLat: real("max_lat").notNull(),
    maxLng: real("max_lng").notNull(),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [index("oneway_ways_bbox_key_idx").on(t.bboxKey), index("oneway_ways_bounds_idx").on(t.minLat, t.maxLat)],
);

/**
 * OpenStreetMap alleys (`highway=service`, `service=alley`), a hint on the map
 * for where to draw a lot (SPEC 24). Centrelines only, cached per way for any
 * CC's day area; no status, no crew. Work in an alley is a drawn lot.
 */
export const osmAlleys = sqliteTable(
  "osm_alleys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    osmId: integer("osm_id").notNull(),
    /** [[lat, lng], ...] in node order. */
    centerline: text("centerline", { mode: "json" }).$type<Array<[number, number]>>().notNull(),
    minLat: real("min_lat").notNull(),
    minLng: real("min_lng").notNull(),
    maxLat: real("max_lat").notNull(),
    maxLng: real("max_lng").notNull(),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [uniqueIndex("osm_alleys_osm_idx").on(t.osmId), index("osm_alleys_bounds_idx").on(t.minLat, t.maxLat)],
);

/** One tag per pass by a surveyor. The newest tag per parcel wins; `clear` takes it off the work list. */
export const surveyTags = sqliteTable(
  "survey_tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    parcelId: text("parcel_id").notNull(),
    grade: text("grade", { enum: SURVEY_GRADES }).notNull(),
    side: text("side", { enum: SURVEY_SIDES }).notNull(),
    note: text("note"),
    /** Where the tagger stood. */
    lat: real("lat"),
    lng: real("lng"),
    heading: real("heading"),
    by: text("by"),
    at: integer("at").notNull(),
  },
  (t) => [index("survey_tags_event_parcel_at").on(t.eventId, t.parcelId, t.at)],
);

/**
 * Attendance and promised headcount of a company on one day. Assignments and
 * Build crews read it; one row per company and day.
 */
export const companyDays = sqliteTable(
  "company_days",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    dayId: integer("day_id")
      .notNull()
      .references(() => days.id, { onDelete: "cascade" }),
    ccId: integer("cc_id").references(() => commandCenters.id, { onDelete: "set null" }),
    headcount: integer("headcount").notNull().default(0),
  },
  (t) => [uniqueIndex("company_days_company_day").on(t.companyId, t.dayId)],
);

/** A block side handed to a company (and a crew once crews exist) on a day. One per block side per event. */
export const assignments = sqliteTable(
  "assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    dayId: integer("day_id")
      .notNull()
      .references(() => days.id, { onDelete: "cascade" }),
    ccId: integer("cc_id")
      .notNull()
      .references(() => commandCenters.id, { onDelete: "cascade" }),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "set null" }),
    crewId: integer("crew_id").references(() => crews.id, { onDelete: "set null" }),
    /** Set when the side went to several crews at once: Publish splits the area's sides between them. */
    areaId: integer("area_id").references(() => crewAreas.id, { onDelete: "set null" }),
    blockSideKey: text("block_side_key").notNull(),
    order: integer("order").notNull().default(0),
  },
  (t) => [uniqueIndex("assignments_event_key").on(t.eventId, t.blockSideKey), index("assignments_day_cc_idx").on(t.dayId, t.ccId)],
);
// #endregion

// #region client errors
/** A crash or unhandled rejection reported by a browser (`POST /client-error`). Read on `/admin/client-errors`. */
export const clientErrors = sqliteTable(
  "client_errors",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    message: text("message").notNull(),
    stack: text("stack"),
    url: text("url"),
    userAgent: text("user_agent"),
    role: text("role"),
  },
  (t) => [index("client_errors_at_idx").on(t.at)],
);
// #endregion

// #region row types
export type Event = typeof events.$inferSelect;
export type Day = typeof days.$inferSelect;
export type CommandCenter = typeof commandCenters.$inferSelect;
export type GreenShirt = typeof greenShirts.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type Crew = typeof crews.$inferSelect;
export type Truck = typeof trucks.$inferSelect;
export type GreenCode = typeof greenCodes.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type RequestType = typeof requestTypes.$inferSelect;
export type Request = typeof requests.$inferSelect;
export type TruckStock = typeof truckStock.$inferSelect;
export type StockMove = typeof stockMoves.$inferSelect;
export type Position = typeof positions.$inferSelect;
export type Lot = typeof lots.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type Broadcast = typeof broadcasts.$inferSelect;
export type Route = typeof routes.$inferSelect;
export type LotPhoto = typeof lotPhotos.$inferSelect;
export type ParcelRow = typeof parcels.$inferSelect;
export type SurveyTag = typeof surveyTags.$inferSelect;
export type CompanyDay = typeof companyDays.$inferSelect;
export type Assignment = typeof assignments.$inferSelect;
export type CrewArea = typeof crewAreas.$inferSelect;
export type OnewayWay = typeof onewayWays.$inferSelect;
export type OsmAlley = typeof osmAlleys.$inferSelect;
export type ClientError = typeof clientErrors.$inferSelect;
// #endregion
