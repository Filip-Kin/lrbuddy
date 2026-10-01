import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ButtonLink } from "../../../components/Button.tsx";
import { useWakeLock } from "../../../components/driver/hooks.ts";
import { lotTitle } from "../../../lib/format.ts";
import { api } from "../../../lib/trpc.ts";
import type { LotGeometry } from "../../../../../server/db/schema.ts";
import { decideTap, LONG_PRESS_MS, nextHeading, pickSides, type DriveParcel, type Fix, type LastTap, type Side } from "./drive.ts";
import { DriveMap, type DriveShape } from "./DriveMap.tsx";
import { distanceM, type LatLng } from "./geo.ts";
import { GradeSheet, type SheetParcel } from "./GradeSheet.tsx";
import { TagQueue } from "./queue.ts";
import { GRADE_LABEL, houseNumber, type Grade } from "./style.ts";
import { geolocation } from "../../../lib/safe.ts";

// #region constants
/** Cached parcels are fetched this far around the car (m)... */
const FETCH_RADIUS_M = 250;
/** ...again once the car is this far from the last fetch (m). */
const REFETCH_M = 100;
const TOAST_MS = 5000;
const ZOOMS = [16.5, 17.5, 18.5, 19.5] as const;
// #endregion

interface P extends DriveParcel {
  geometry: LotGeometry | null;
  grade: Grade | null;
}

type GpsState = "waiting" | "on" | "denied" | "unavailable";

interface Toast {
  text: string;
  /** Queue id to take back; null for a message without Undo. */
  localId: number | null;
  parcelId: string | null;
  prev: Grade | null;
  key: number;
}

const ArrowIcon = ({ dir }: { dir: Side }) => (
  <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <path d={dir === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
  </svg>
);

/** A refusal from the server drops a queued tag; anything else (no signal, signed out) keeps it. */
const isRefusal = (err: unknown): boolean => err instanceof TRPCClientError && typeof err.data?.code === "string" && err.data.code !== "UNAUTHORIZED";

/** Survey drive mode (SPEC 16): heading-up map, Left and Right tag the nearest parcel on that side. */
export const DrivePage = () => {
  useWakeLock();
  const [gps, setGps] = useState<GpsState>("waiting");
  const [fix, setFix] = useState<Fix | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const anchor = useRef<LatLng | null>(null);
  const headingRef = useRef<number | null>(null);
  const [zoomIx, setZoomIx] = useState(2);
  const parcels = useRef(new Map<string, P>());
  /** Grades set here, which win over a refetch until the server has them. */
  const local = useRef(new Map<string, Grade | null>());
  const [version, setVersion] = useState(0);
  const lastFetch = useRef<LatLng | null>(null);
  const fetching = useRef(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const lastTap = useRef<LastTap | null>(null);
  const [sheet, setSheet] = useState<{ side: Side; parcel: SheetParcel } | null>(null);
  const [queueState, setQueueState] = useState({ pending: 0, stalled: false });
  const [online, setOnline] = useState(() => navigator.onLine);

  // #region queue
  const queue = useMemo(
    () =>
      new TagQueue({
        sendTag: async (input) => {
          const r = await api.plan.survey.tag.mutate(input);
          return { tagId: r.tag.id };
        },
        sendUndo: async (tagId) => {
          await api.plan.survey.undo.mutate({ id: tagId });
        },
        isRefusal,
      }),
    [],
  );
  useEffect(() => {
    const sync = (): void => setQueueState({ pending: queue.pending, stalled: queue.stalled });
    queue.listen({
      onChange: sync,
      onRefused: () => setToast({ text: "Not saved", localId: null, parcelId: null, prev: null, key: Date.now() }),
    });
    const up = (): void => {
      setOnline(true);
      queue.kick();
    };
    const down = (): void => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      queue.dispose();
    };
  }, [queue]);
  // #endregion

  // #region gps
  useEffect(() => {
    const geo = geolocation();
    if (!geo) {
      setGps("unavailable");
      return;
    }
    const id = geo.watchPosition(
      (pos) => {
        const c = pos.coords;
        const f: Fix = {
          lat: c.latitude,
          lng: c.longitude,
          accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
          heading: c.heading !== null && Number.isFinite(c.heading) ? c.heading : null,
          speed: c.speed !== null && Number.isFinite(c.speed) ? c.speed : null,
          at: pos.timestamp || Date.now(),
        };
        const h = nextHeading(f, anchor.current, headingRef.current);
        anchor.current = h.anchor;
        headingRef.current = h.heading;
        setHeading(h.heading);
        setFix(f);
        setGps("on");
      },
      (err) => setGps(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable"),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
    return () => geo.clearWatch(id);
  }, []);
  // #endregion

  // #region parcels around the car
  useEffect(() => {
    if (!fix || fetching.current) return;
    if (lastFetch.current && distanceM(lastFetch.current, fix) < REFETCH_M) return;
    fetching.current = true;
    const at = { lat: fix.lat, lng: fix.lng };
    api.plan.survey.near
      .query({ lat: at.lat, lng: at.lng, radiusM: FETCH_RADIUS_M })
      .then((rows) => {
        for (const r of rows) {
          const mine = local.current.get(r.parcelId);
          parcels.current.set(r.parcelId, {
            parcelId: r.parcelId,
            address: r.address,
            streetName: r.streetName,
            lat: r.lat,
            lng: r.lng,
            geometry: r.geometry,
            grade: mine !== undefined ? mine : r.grade,
          });
        }
        lastFetch.current = at;
        setVersion((v) => v + 1);
      })
      .catch(() => undefined)
      .finally(() => {
        fetching.current = false;
      });
  }, [fix]);
  // #endregion

  const sides = useMemo(
    () => (fix && heading !== null ? pickSides(parcels.current.values(), fix, heading) : { left: [], right: [] }),
    [fix, heading, version],
  );
  const target = (s: Side): P | null => sides[s][0]?.parcel ?? null;

  const shapes = useMemo<DriveShape[]>(() => {
    const rank = new Map<string, 1 | 2>();
    for (const s of ["left", "right"] as const) sides[s].forEach((c, i) => rank.set(c.parcel.parcelId, i === 0 ? 1 : 2));
    const out: DriveShape[] = [];
    for (const p of parcels.current.values()) {
      if (fix && distanceM(fix, p) > 180) continue;
      out.push({ parcelId: p.parcelId, lat: p.lat, lng: p.lng, geometry: p.geometry, grade: p.grade, rank: rank.get(p.parcelId) ?? null, label: houseNumber(p.address) });
    }
    return out;
  }, [sides, version, fix]);

  // #region tagging
  const setGrade = (parcelId: string, g: Grade | null): void => {
    const p = parcels.current.get(parcelId);
    local.current.set(parcelId, g);
    if (p) p.grade = g;
    setVersion((v) => v + 1);
  };

  const tagParcel = useCallback(
    (p: P, grade: Grade, side: Side, note: string | null = null): void => {
      const prev = p.grade;
      const localId = queue.tag({
        parcelId: p.parcelId,
        grade,
        side,
        note,
        lat: fix?.lat ?? null,
        lng: fix?.lng ?? null,
        heading: headingRef.current,
        at: Date.now(),
      });
      setGrade(p.parcelId, grade);
      navigator.vibrate?.(grade === "high" ? [30, 60, 30] : 30);
      setToast({ text: `${GRADE_LABEL[grade]}, ${lotTitle(p)}`, localId, parcelId: p.parcelId, prev, key: Date.now() });
    },
    [queue, fix],
  );

  const tap = (side: Side): void => {
    const now = Date.now();
    const d = decideTap(side, now, lastTap.current, target(side)?.parcelId ?? null);
    if (!d) return;
    const p = parcels.current.get(d.parcelId);
    if (!p) return;
    lastTap.current = { side, parcelId: d.parcelId, grade: d.grade, at: now };
    tagParcel(p, d.grade, side);
  };

  const undo = (): void => {
    if (!toast || toast.localId === null || !toast.parcelId) return;
    queue.undo(toast.localId);
    setGrade(toast.parcelId, toast.prev);
    lastTap.current = null;
    setToast(null);
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast((cur) => (cur?.key === toast.key ? null : cur)), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);
  // #endregion

  // #region long press
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; long: boolean }>({ timer: null, long: false });
  const onDown = (side: Side) => (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    press.current.long = false;
    if (press.current.timer) clearTimeout(press.current.timer);
    press.current.timer = setTimeout(() => {
      press.current.timer = null;
      const p = target(side);
      if (!p) return;
      press.current.long = true;
      navigator.vibrate?.(15);
      setSheet({ side, parcel: { parcelId: p.parcelId, address: lotTitle(p), grade: p.grade } });
    }, LONG_PRESS_MS);
  };
  const cancelPress = (): void => {
    if (press.current.timer) clearTimeout(press.current.timer);
    press.current.timer = null;
  };
  const onClick = (side: Side) => () => {
    cancelPress();
    if (press.current.long) {
      press.current.long = false;
      return;
    }
    tap(side);
  };
  // #endregion

  const status =
    gps === "denied" || gps === "unavailable"
      ? null
      : !fix
          ? "Waiting for GPS"
          : heading === null
            ? "No heading"
            : parcels.current.size === 0
              ? "No parcels loaded"
              : null;
  const queued = queueState.pending > 0 && (queueState.stalled || !online) ? queueState.pending : 0;

  const sideButton = (side: Side) => {
    const p = target(side);
    const label = side === "left" ? "Left" : "Right";
    return (
      <button
        type="button"
        disabled={!p}
        onPointerDown={onDown(side)}
        onPointerUp={() => cancelPress()}
        onPointerLeave={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(e) => e.preventDefault()}
        onClick={onClick(side)}
        aria-label={p ? `${label}, ${lotTitle(p)}` : label}
        data-side={side}
        className="flex min-h-0 min-w-0 flex-col items-center justify-center gap-1 rounded-3xl bg-brand px-3 text-on-brand shadow-md select-none [-webkit-touch-callout:none] active:brightness-90 disabled:bg-surface disabled:text-muted disabled:shadow-none disabled:ring-1 disabled:ring-line"
      >
        <span className="flex items-center gap-1 text-3xl font-extrabold">
          {side === "left" && <ArrowIcon dir="left" />}
          {label}
          {side === "right" && <ArrowIcon dir="right" />}
        </span>
        <span className="max-w-full truncate text-base font-semibold">{p ? lotTitle(p) : "No parcel"}</span>
        {p?.grade && <span className="rounded-full bg-on-brand/15 px-2.5 py-0.5 text-sm font-bold">{GRADE_LABEL[p.grade]}</span>}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <DriveMap fix={fix} heading={heading} shapes={shapes} zoom={ZOOMS[zoomIx] ?? 18.5} />
        <div className="pointer-events-none absolute inset-x-2 top-2 z-[1000] flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap gap-1.5" role="status" aria-live="polite">
            {status && <span className="rounded-full bg-bar px-3 py-1.5 text-sm font-semibold text-bar-text shadow">{status}</span>}
            {queued > 0 && (
              <span data-queued className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-sm font-bold text-ink shadow ring-2 ring-warn ring-inset">
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-warn" />
                {`${queued} queued`}
              </span>
            )}
          </div>
          <div className="pointer-events-auto flex flex-col overflow-hidden rounded-xl bg-surface shadow ring-1 ring-line">
            <button type="button" aria-label="Zoom in" disabled={zoomIx >= ZOOMS.length - 1} onClick={() => setZoomIx((z) => Math.min(ZOOMS.length - 1, z + 1))} className="grid h-11 w-11 place-items-center text-2xl font-bold disabled:opacity-40">
              +
            </button>
            <button type="button" aria-label="Zoom out" disabled={zoomIx <= 0} onClick={() => setZoomIx((z) => Math.max(0, z - 1))} className="grid h-11 w-11 place-items-center border-t border-line text-2xl font-bold disabled:opacity-40">
              −
            </button>
          </div>
        </div>
        {(gps === "denied" || gps === "unavailable") && (
          <div className="absolute inset-x-4 top-1/3 z-[1000] flex justify-center">
            <div className="rounded-2xl bg-surface px-5 py-4 text-center shadow-lg ring-1 ring-line">
              <p className="font-semibold">{gps === "denied" ? "Location blocked" : "No GPS"}</p>
              <ButtonLink href="/plan/survey" variant="secondary" size="sm" className="mt-3">
                Survey
              </ButtonLink>
            </div>
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-2 bottom-2 z-[1000] flex flex-col items-center gap-1">
          <div role="status" aria-live="polite" className="w-full empty:hidden">
            {toast && (
              <div className="pointer-events-auto mx-auto flex max-w-md items-center justify-between gap-3 rounded-2xl bg-bar py-1.5 pr-1.5 pl-4 text-bar-text shadow-lg">
                <span className="min-w-0 truncate font-semibold">{toast.text}</span>
                {toast.localId !== null && (
                  <button type="button" onClick={undo} className="min-h-11 shrink-0 rounded-xl bg-surface px-4 font-bold text-ink">
                    Undo
                  </button>
                )}
              </div>
            )}
          </div>
          <span className="self-end rounded bg-surface/80 px-1 text-[10px] text-muted">© OpenStreetMap contributors, © Esri</span>
        </div>
      </div>
      <div className="grid h-[33dvh] shrink-0 grid-cols-2 gap-2 border-t border-line bg-surface-2 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {sideButton("left")}
        {sideButton("right")}
      </div>
      <GradeSheet
        parcel={sheet?.parcel ?? null}
        onClose={() => setSheet(null)}
        onSave={(grade, note) => {
          const s = sheet;
          if (!s) return;
          const p = parcels.current.get(s.parcel.parcelId);
          if (p) tagParcel(p, grade, s.side, note);
          lastTap.current = null;
          setSheet(null);
        }}
      />
    </div>
  );
};
