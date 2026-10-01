import type L from "leaflet";
import { useState } from "react";
import { errorText } from "../../lib/errors.ts";
import { useAlleyLayer, type AlleyItem } from "../../lib/map/alleyLayer.ts";
import { trpc } from "../../lib/trpc.ts";
import { Sheet } from "../Sheet.tsx";

type Status = AlleyItem["status"];

/** One set of words for alleys, the lot words of SPEC 21. */
export const ALLEY_STATUS_LABEL: Record<Status, string> = {
  open: "Todo",
  in_progress: "In progress",
  done: "Done",
  do_not_touch: "Do not touch",
};
const ORDER: readonly Status[] = ["open", "in_progress", "done", "do_not_touch"];
const DOT: Record<Status, string> = { open: "bg-crew", in_progress: "bg-brand", done: "bg-brand-green", do_not_touch: "bg-warn" };

const AlleySheet = ({ alley, onClose }: { alley: AlleyItem | null; onClose: () => void }) => {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Status | null>(null);
  const set = trpc.alleys.setStatus.useMutation({
    onMutate: ({ status }) => {
      setError(null);
      setShown(status);
    },
    onSuccess: () => void utils.alleys.inView.invalidate(),
    onError: (e) => {
      setShown(null);
      setError(errorText(e));
    },
  });
  const current = shown ?? alley?.status ?? "open";
  return (
    <Sheet
      open={alley !== null}
      onClose={() => {
        setShown(null);
        setError(null);
        onClose();
      }}
      title={alley?.label ?? "Alley"}
    >
      <div className="space-y-3 pb-2">
        {alley?.span && <p className="text-sm text-muted">{alley.span}</p>}
        <div role="radiogroup" aria-label="Status" className="grid grid-cols-2 gap-2" data-alley-status>
          {ORDER.map((s) => {
            const on = s === current;
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={set.isPending}
                onClick={() => alley && s !== current && set.mutate({ id: alley.id, status: s })}
                className={`flex min-h-12 items-center justify-center gap-2 rounded-2xl px-3 text-base font-semibold ring-1 ring-inset ${
                  on ? "bg-brand text-on-brand ring-brand" : "bg-surface-2 text-ink ring-line"
                }`}
              >
                <span aria-hidden="true" className={`h-3 w-3 shrink-0 rounded-full ring-1 ring-ink/40 ${DOT[s]}`} />
                {ALLEY_STATUS_LABEL[s]}
              </button>
            );
          })}
        </div>
        {error && (
          <p role="alert" className="text-sm font-semibold text-ink">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
};

/** Alleys on a map with their status sheet. Render next to the map: `<AlleyLayer map={map} />`. */
export const AlleyLayer = ({ map }: { map: L.Map | null }) => {
  const [picked, setPicked] = useState<number | null>(null);
  const items = useAlleyLayer(map, (a) => setPicked(a.id));
  const alley = picked === null ? null : (items.find((a) => a.id === picked) ?? null);
  return <AlleySheet alley={alley} onClose={() => setPicked(null)} />;
};
