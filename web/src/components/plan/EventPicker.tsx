import { useId } from "react";
import { errorText } from "../../lib/errors.ts";
import { trpc } from "../../lib/trpc.ts";

/**
 * The portal's event: a select over every event that makes the picked one
 * active. Every portal page works on the active event. `tone` matches the
 * surface it sits on: the laptop rail or the dark phone drawer.
 */
export const EventPicker = ({ tone = "rail" }: { tone?: "rail" | "bar" }) => {
  const selectId = useId();
  const utils = trpc.useUtils();
  const events = trpc.admin.events.list.useQuery(undefined, { staleTime: 60_000 });
  const setActive = trpc.admin.events.setActive.useMutation({ onSuccess: () => void utils.invalidate() });
  const list = events.data ?? [];
  const active = list.find((e) => e.active) ?? null;
  const label = tone === "bar" ? "text-bar-text/80" : "text-muted";
  const control =
    tone === "bar"
      ? "bg-white/10 text-bar-text ring-white/25 focus:ring-bar-text [&>option]:text-ink [&>option]:bg-surface"
      : "bg-surface text-ink ring-line focus:ring-ink";
  return (
    <div className="space-y-1">
      <label htmlFor={selectId} className={`block text-xs font-bold tracking-wider uppercase ${label}`}>
        Event
      </label>
      <select
        id={selectId}
        className={`block min-h-11 w-full rounded-xl border-0 px-3 py-2 text-base ring-1 ring-inset focus:ring-2 focus:outline-none ${control}`}
        value={active?.id ?? ""}
        disabled={events.isLoading || setActive.isPending}
        onChange={(e) => setActive.mutate({ id: Number(e.target.value) })}
      >
        {active === null && <option value="">No active event</option>}
        {list.map((ev) => (
          <option key={ev.id} value={ev.id}>
            {ev.name}
          </option>
        ))}
      </select>
      {setActive.error && (
        <p role="alert" className={`text-sm font-semibold ${tone === "bar" ? "text-bar-text" : "text-ink"}`}>
          {errorText(setActive.error)}
        </p>
      )}
    </div>
  );
};
