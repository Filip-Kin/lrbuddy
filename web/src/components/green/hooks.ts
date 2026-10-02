import { errorText as baseErrorText } from "../../lib/errors.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";
import { storageGet, storageSet } from "../../lib/safe.ts";

export type GreenRequest = RouterOutputs["green"]["requests"][number];
export type GreenTruck = RouterOutputs["green"]["trucks"][number];
export type GreenCrew = RouterOutputs["green"]["crews"][number];

/** Re-renders every `ms` so ages and "last seen" stay current between refetches. */
export const useNow = (ms = 30_000): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
};

/** Short message from a tRPC error, in the server's words. */
export const errorText = (err: unknown): string => baseErrorText(err, "Not saved. Check the connection and try again.");

/** Everything a green screen shows is one family of queries; any change refetches it. */
export const useGreenInvalidate = (): (() => void) => {
  const utils = trpc.useUtils();
  return useCallback(() => {
    void utils.green.invalidate();
  }, [utils]);
};

/** Assign, Cancel and Delivered, shared by the board and the map cards. */
export const useRequestActions = () => {
  const refresh = useGreenInvalidate();
  const assign = trpc.green.assign.useMutation({ onSettled: refresh });
  const cancel = trpc.green.cancel.useMutation({ onSettled: refresh });
  const deliver = trpc.green.deliver.useMutation({ onSettled: refresh });
  return { assign, cancel, deliver };
};

// #region sound
const SOUND_KEY = "lrb.green.sound";

/** Off by default; remembered per device. */
export const useSoundSetting = (): [boolean, (on: boolean) => void] => {
  const [on, setOn] = useState(() => storageGet("local", SOUND_KEY) === "1");
  const set = useCallback((v: boolean) => {
    setOn(v);
    storageSet("local", SOUND_KEY, v ? "1" : "0");
    if (v) void chime();
  }, []);
  return [on, set];
};

let audio: AudioContext | null = null;

/** Two short rising tones. Generated, so there is no sound file to load. */
export const chime = async (): Promise<void> => {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") await audio.resume();
    const t0 = audio.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = t0 + i * 0.16;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(start + 0.3);
    }
  } catch {
    // No audio on this device; the board still updates.
  }
};

/** Plays the chime once per request id that appears after the first load. */
export const useNewRequestChime = (rows: readonly GreenRequest[] | undefined, enabled: boolean): void => {
  const seen = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!rows) return;
    const ids = rows.map((r) => r.id);
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const fresh = rows.filter((r) => !seen.current!.has(r.id) && r.status !== "cancelled" && r.status !== "delivered");
    for (const id of ids) seen.current.add(id);
    if (enabled && fresh.length > 0) void chime();
  }, [rows, enabled]);
};
// #endregion

/** Crew name for a request card, or the green-entered label for a crewless stop. */
export const requestWho = (r: Pick<GreenRequest, "crewName" | "label">): string => r.crewName ?? r.label ?? "Map stop";

/** Priority 3 still waiting after 10 minutes, the same rule dispatch uses to route it first. */
export const isUrgent = (r: Pick<GreenRequest, "priority" | "status" | "createdAt">, now: number): boolean =>
  r.priority >= 3 && (r.status === "open" || r.status === "assigned" || r.status === "en_route") && now - r.createdAt > 10 * 60_000;

/** "Water x2". */
export const itemLine = (r: Pick<GreenRequest, "typeLabel" | "qty">): string => `${r.typeLabel} x${r.qty}`;
