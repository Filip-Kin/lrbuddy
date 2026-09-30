import { useState } from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "../../lib/trpc.ts";
import { since } from "./format.ts";
import { CloseIcon, MegaphoneIcon } from "./Icons.tsx";
import { useNow } from "./useNow.ts";

const KEY = "lrb.crew.broadcast.seen";
/** Older broadcasts stay on the command center page only. */
const FRESH_MS = 2 * 60 * 60_000;

const seenId = (): number => {
  const v = Number(window.localStorage.getItem(KEY));
  return Number.isInteger(v) ? v : 0;
};

/**
 * The command center's latest broadcast, above every crew page until closed.
 * Hidden on the command center page, which leads with it anyway.
 */
export const BroadcastBanner = () => {
  const [loc] = useLocation();
  const now = useNow(60_000);
  const latest = trpc.shared.latestBroadcast.useQuery(undefined, { refetchInterval: 60_000 });
  const [seen, setSeen] = useState(seenId);
  const b = latest.data;
  if (!b || loc === "/cc" || b.id <= seen || now - b.at > FRESH_MS) return null;
  const close = (): void => {
    window.localStorage.setItem(KEY, String(b.id));
    setSeen(b.id);
  };
  return (
    <div role="status" className="flex items-stretch gap-1 bg-brand text-on-brand shadow-sm">
      <Link href="/cc" className="flex min-w-0 flex-1 items-start gap-3 py-2.5 pl-4">
        <MegaphoneIcon size={22} className="mt-0.5 shrink-0" />
        <span className="min-w-0">
          <span className="line-clamp-3 font-semibold break-words">{b.body}</span>
          <span className="text-sm opacity-80">
            {b.sentBy ? `${b.sentBy}, ` : ""}
            {since(b.at, now)}
          </span>
        </span>
      </Link>
      <button type="button" onClick={close} aria-label="Close" className="grid w-12 shrink-0 place-items-center self-stretch">
        <CloseIcon size={22} />
      </button>
    </div>
  );
};
