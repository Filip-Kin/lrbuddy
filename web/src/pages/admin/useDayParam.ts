import { useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { trpc } from "../../lib/trpc.ts";

/**
 * The day an admin screen shows, kept in `?day=` so a reload or a shared link
 * lands on the same day. Defaults to the first day with crews, else the first day.
 */
export const useDayParam = () => {
  const days = trpc.admin.days.list.useQuery(undefined, { retry: false });
  const search = new URLSearchParams(useSearch());
  const [loc, navigate] = useLocation();
  const asked = Number(search.get("day"));
  const list = days.data ?? [];
  const current = list.find((d) => d.id === asked) ?? list.find((d) => d.crewCount > 0) ?? list[0] ?? null;
  const setDay = (id: number): void => {
    const next = new URLSearchParams(search);
    next.set("day", String(id));
    navigate(`${loc}?${next.toString()}`, { replace: true });
  };
  useEffect(() => {
    if (!days.data || !search.get("day") || current === null) return;
    if (current.id !== asked) setDay(current.id);
    // Keyed on the day id only; `search` is a new object every render.
  }, [days.data, asked, current?.id]);
  return { days: list, day: current, setDay, loading: days.isLoading, noEvent: days.error?.data?.code === "PRECONDITION_FAILED" };
};
