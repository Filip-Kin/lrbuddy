import { StatusPill } from "../StatusPill.tsx";

/** A truck unseen for 15 minutes gets no new requests (SPEC 7), so it reads as No signal everywhere. */
const STALE_MS = 15 * 60_000;

export const noSignal = (t: { status: string; lastSeenAt: number | null }, now: number): boolean =>
  t.status !== "offline" && (t.lastSeenAt === null || now - t.lastSeenAt > STALE_MS);

type TruckStatus = "idle" | "delivering" | "returning" | "offline";

/** The one status pill for a truck on every green screen. */
export const TruckStatusPill = ({ truck, now }: { truck: { status: TruckStatus; lastSeenAt: number | null }; now: number }) =>
  noSignal(truck, now) ? <StatusPill status="offline" label="No signal" /> : <StatusPill status={truck.status} />;
