import type { Map as LeafletMap } from "leaflet";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { LotGeometry } from "../../../server/db/schema.ts";
import { errorText } from "../lib/errors.ts";
import type { LotStatus } from "../lib/lotStatus.ts";
import { acrossM, polygonOf, useDrawPolygon, type LatLng } from "../lib/map/drawPolygon.ts";
import { trpc } from "../lib/trpc.ts";
import { Button } from "./Button.tsx";
import { Field, Select } from "./Field.tsx";
import { LotStatusControl } from "./LotStatusControl.tsx";
import { Sheet } from "./Sheet.tsx";

// #region state
export type DrawScope = { kind: "green" } | { kind: "admin"; ccId: number | null };

type Mode = { kind: "new" } | { kind: "edit"; lotId: number } | null;

/** The outline of a drawn lot as points, without the closing repeat. */
const pointsOf = (g: LotGeometry): LatLng[] => {
  const ring = g.type === "Polygon" ? (g.coordinates[0] ?? []) : (g.coordinates[0]?.[0] ?? []);
  const pts = ring.map((p) => ({ lng: p[0] ?? 0, lat: p[1] ?? 0 }));
  const a = pts[0];
  const b = pts[pts.length - 1];
  return a && b && pts.length > 1 && a.lat === b.lat && a.lng === b.lng ? pts.slice(0, -1) : pts;
};

/**
 * Draw lot and Edit shape on one map (SPEC 24): the points, the bar along the
 * top and the Save sheet. `onSaved` hears the lot's name after a save.
 */
export const useDrawLot = (map: LeafletMap | null, scope: DrawScope, onSaved: (text: string) => void) => {
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<Mode>(null);
  const [points, setPoints] = useState<LatLng[]>([]);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const greenEdit = trpc.green.editLotShape.useMutation();
  const adminEdit = trpc.admin.lots.editLotShape.useMutation();

  const refetch = async (): Promise<void> => {
    if (scope.kind === "green") await utils.green.invalidate();
    else await Promise.all([utils.admin.lots.invalidate(), utils.admin.overview.invalidate()]);
  };

  const tryClose = (): void => {
    if (points.length < 3) return;
    if (acrossM(points) < 10) {
      setError("Under 10 m across");
      return;
    }
    setError(null);
    setClosed(true);
  };

  useDrawPolygon(map, {
    active: mode !== null,
    points,
    closed,
    onPoints: (p) => {
      setError(null);
      setPoints(p);
    },
    onClose: tryClose,
  });

  const stop = (): void => {
    setMode(null);
    setPoints([]);
    setClosed(false);
    setError(null);
  };

  const saveShape = (): void => {
    if (mode?.kind !== "edit") return;
    if (acrossM(points) < 10) {
      setError("Under 10 m across");
      return;
    }
    const input = { lotId: mode.lotId, polygon: polygonOf(points) };
    const done = {
      onSuccess: () => {
        void refetch();
        onSaved("Shape saved");
        stop();
      },
      onError: (e: unknown) => setError(errorText(e)),
    };
    if (scope.kind === "green") greenEdit.mutate(input, done);
    else adminEdit.mutate(input, done);
  };

  return {
    mode,
    points,
    closed,
    error,
    /** Draw lot: an empty outline, taps add points. */
    start: (): void => {
      stop();
      setMode({ kind: "new" });
    },
    /** Edit shape: the lot's outline with its points to drag. */
    edit: (lotId: number, geometry: LotGeometry): void => {
      setError(null);
      setPoints(pointsOf(geometry));
      setClosed(true);
      setMode({ kind: "edit", lotId });
    },
    undoPoint: (): void => {
      setError(null);
      setPoints((p) => p.slice(0, -1));
    },
    close: tryClose,
    reopen: (): void => setClosed(false),
    stop,
    saveShape,
    saving: greenEdit.isPending || adminEdit.isPending,
    refetch,
  };
};
export type DrawLotState = ReturnType<typeof useDrawLot>;
// #endregion

// #region bar
export const DrawLotIcon = () => (
  <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
    <path d="M4 18l3-12 7 3 6-3-2 13z" />
    <circle cx="4" cy="18" r="1.6" fill="currentColor" />
    <circle cx="7" cy="6" r="1.6" fill="currentColor" />
    <circle cx="18" cy="19" r="1.6" fill="currentColor" />
  </svg>
);

const pointsLabel = (n: number): string => `${n} ${n === 1 ? "point" : "points"}`;

/** The bar across the top of the map while a lot is drawn or its shape edited. */
export const DrawLotBar = ({ draw }: { draw: DrawLotState }) => {
  if (!draw.mode || (draw.mode.kind === "new" && draw.closed)) return null;
  const editing = draw.mode.kind === "edit";
  return (
    <div className="pointer-events-none absolute inset-x-2 top-2 z-[1000] flex justify-center">
      <div
        data-draw-lot-bar
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 rounded-2xl bg-bar py-1.5 pr-1.5 pl-4 text-bar-text shadow-lg"
      >
        <span className="min-w-0 font-semibold">
          {editing ? "Edit shape" : "Draw lot"}
          <span className="ml-2 font-normal opacity-80">{draw.error ?? pointsLabel(draw.points.length)}</span>
        </span>
        <span className="flex flex-wrap gap-1.5">
          {!editing && (
            <Button variant="secondary" size="sm" data-draw-undo disabled={draw.points.length === 0} onClick={draw.undoPoint}>
              Undo point
            </Button>
          )}
          {editing ? (
            <Button size="sm" data-draw-save busy={draw.saving} onClick={draw.saveShape}>
              Save
            </Button>
          ) : (
            <Button size="sm" data-draw-close disabled={draw.points.length < 3} onClick={draw.close}>
              Close
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={draw.stop}>
            Cancel
          </Button>
        </span>
      </div>
    </div>
  );
};
// #endregion

// #region save sheet
/**
 * After Close: Name (prefilled "Alley, Lawrence to Collingwood" for a long
 * thin shape, else "Lot"), status (Todo), crew (the rectangle's), Save.
 * `ccPicker` is the admin map's CC select.
 */
export const DrawLotSheet = ({
  draw,
  scope,
  crews,
  ccPicker,
  onSaved,
}: {
  draw: DrawLotState;
  scope: DrawScope;
  crews: ReadonlyArray<{ id: number; name: string }>;
  ccPicker?: ReactNode;
  onSaved: (text: string) => void;
}) => {
  const open = draw.mode?.kind === "new" && draw.closed;
  const polygon = useMemo(() => (open && draw.points.length >= 3 ? polygonOf(draw.points) : null), [open, draw.points]);
  const adminCc = scope.kind === "admin" ? scope.ccId : null;
  const greenStart = trpc.green.drawLotStart.useQuery({ polygon: polygon ?? polygonOf([{ lat: 0, lng: 0 }]) }, { enabled: polygon !== null && scope.kind === "green", retry: false });
  const adminStart = trpc.admin.lots.drawLotStart.useQuery(
    { ccId: adminCc ?? 0, polygon: polygon ?? polygonOf([{ lat: 0, lng: 0 }]) },
    { enabled: polygon !== null && adminCc !== null, retry: false },
  );
  const start = scope.kind === "green" ? greenStart : adminStart;
  const [name, setName] = useState("");
  const [status, setStatus] = useState<LotStatus>("open");
  const [crewId, setCrewId] = useState<number | null>(null);
  const [touched, setTouched] = useState({ name: false, crew: false });
  const [error, setError] = useState<string | null>(null);
  const greenSave = trpc.green.drawLot.useMutation();
  const adminSave = trpc.admin.lots.drawLot.useMutation();

  useEffect(() => {
    if (!open) return;
    setName("");
    setStatus("open");
    setCrewId(null);
    setTouched({ name: false, crew: false });
    setError(null);
  }, [open]);
  useEffect(() => {
    const s = start.data;
    if (!s) return;
    if (!touched.name) setName(s.name);
    if (!touched.crew) setCrewId(s.crewId);
  }, [start.data]);

  if (!open || !polygon) return null;
  const save = (): void => {
    setError(null);
    const body = { polygon, name: name.trim() || "Lot", status, crewId };
    const done = {
      onSuccess: () => {
        void draw.refetch();
        onSaved(`${body.name} saved`);
        draw.stop();
      },
      onError: (e: unknown) => setError(errorText(e)),
    };
    if (scope.kind === "green") greenSave.mutate(body, done);
    else if (scope.ccId !== null) adminSave.mutate({ ...body, ccId: scope.ccId }, done);
  };
  return (
    <Sheet
      open
      onClose={draw.reopen}
      title="Draw lot"
      footer={
        <Button block size="lg" data-draw-lot-save busy={greenSave.isPending || adminSave.isPending} disabled={start.isLoading} onClick={save}>
          Save
        </Button>
      }
    >
      <div className="space-y-4 pb-2">
        {ccPicker}
        <Field
          label="Name"
          value={name}
          maxLength={120}
          autoComplete="off"
          placeholder={start.isLoading ? "Lot" : undefined}
          onChange={(e) => {
            setTouched((t) => ({ ...t, name: true }));
            setName(e.target.value);
          }}
        />
        <LotStatusControl status={status} canDnt onChange={setStatus} />
        <Select
          label="Crew"
          value={crewId ?? ""}
          onChange={(e) => {
            setTouched((t) => ({ ...t, crew: true }));
            setCrewId(e.target.value ? Number(e.target.value) : null);
          }}
        >
          <option value="">No crew</option>
          {crews.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {error && (
          <p role="alert" className="text-sm font-semibold">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
};
// #endregion
