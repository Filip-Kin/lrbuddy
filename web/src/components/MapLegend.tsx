import { STATUS_LABEL, STATUS_ORDER, type LotStatus } from "../lib/lotStatus.ts";
import { onewayLegendSvg } from "../lib/map/onewayLayer.ts";
import { TireGlyph } from "./TirePile.tsx";

/** A parcel in its status colour, drawn the way the map draws it (SPEC 21 table). */
const Swatch = ({ status }: { status: LotStatus }) => {
  const style: Record<LotStatus, { stroke: string; fill: string; opacity: number; width: number }> = {
    not_todo: { stroke: "var(--muted)", fill: "none", opacity: 0, width: 1 },
    open: { stroke: "var(--crew)", fill: "var(--crew)", opacity: 0.3, width: 2 },
    in_progress: { stroke: "var(--brand)", fill: "var(--brand)", opacity: 0.3, width: 2 },
    done: { stroke: "var(--brand-green)", fill: "var(--brand-green)", opacity: 0.3, width: 2 },
    not_done: { stroke: "var(--not-done)", fill: "var(--not-done)", opacity: 0.3, width: 2 },
    do_not_touch: { stroke: "var(--warn)", fill: "var(--warn)", opacity: 0.12, width: 2 },
  };
  const s = style[status];
  return (
    <svg viewBox="0 0 18 12" width="18" height="12" aria-hidden="true" className="shrink-0">
      <rect x="1" y="1" width="16" height="10" fill={s.fill} fillOpacity={s.opacity} stroke={s.stroke} strokeWidth={s.width} strokeDasharray={status === "not_done" ? "3 2" : undefined} />
      {status === "do_not_touch" && <path d="M1 7l6-6M5 11l10-10M11 11l6-6" stroke="var(--warn)" strokeWidth="1.3" />}
    </svg>
  );
};

/** The six parcel statuses in their order (SPEC 21: one set of words everywhere), then one-way streets, tire piles (SPEC 29), and OSM alleys while shown. */
export const MapLegend = ({ className = "", osmAlleys = false }: { className?: string; osmAlleys?: boolean }) => (
  <ul aria-label="Legend" data-legend className={`pointer-events-none space-y-0.5 rounded-xl bg-surface/90 px-2 py-1.5 text-[11px] leading-tight font-semibold text-ink shadow ring-1 ring-line ${className}`}>
    {STATUS_ORDER.map((s) => (
      <li key={s} className="flex items-center gap-1.5">
        <Swatch status={s} />
        {STATUS_LABEL[s]}
      </li>
    ))}
    <li className="flex items-center gap-1.5">
      <span aria-hidden="true" className="grid w-[18px] shrink-0 place-items-center [&>svg]:h-3.5 [&>svg]:w-3.5" dangerouslySetInnerHTML={{ __html: onewayLegendSvg }} />
      One way
    </li>
    <li className="flex items-center gap-1.5">
      <span className="grid w-[18px] shrink-0 place-items-center">
        <TireGlyph size={14} />
      </span>
      Tire pile
    </li>
    {osmAlleys && (
      <li className="flex items-center gap-1.5">
        <svg viewBox="0 0 18 12" width="18" height="12" aria-hidden="true" className="shrink-0">
          <path d="M1 6h16" stroke="var(--ink)" strokeWidth="1.5" strokeDasharray="3 2" />
        </svg>
        OSM alley
      </li>
    )}
  </ul>
);
