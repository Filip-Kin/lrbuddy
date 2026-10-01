import { useState } from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "../lib/trpc.ts";
import { since } from "./crew/format.ts";
import { CloseIcon, MegaphoneIcon } from "./crew/Icons.tsx";
import { useNow } from "./crew/useNow.ts";
import { storageGet, storageSet } from "../lib/safe.ts";

const KEY = "lrb.broadcast.seen";
/** Older broadcasts stay on the command center page only. */
const FRESH_MS = 2 * 60 * 60_000;

const seenId = (): number => {
  const v = Number(storageGet("local", KEY));
  return Number.isInteger(v) ? v : 0;
};

/**
 * The command center's latest broadcast, above every crew and driver page
 * until closed. With `ccHref` the text links to the command center page, and
 * the banner hides there, since that page leads with it anyway.
 */
export const BroadcastBanner = ({ ccHref }: { ccHref?: string }) => {
  const [loc] = useLocation();
  const now = useNow(60_000);
  const latest = trpc.shared.latestBroadcast.useQuery(undefined, { refetchInterval: 60_000 });
  const [seen, setSeen] = useState(seenId);
  const b = latest.data;
  if (!b || (ccHref !== undefined && loc === ccHref) || b.id <= seen || now - b.at > FRESH_MS) return null;
  const close = (): void => {
    storageSet("local", KEY, String(b.id));
    setSeen(b.id);
  };
  const text = (
    <>
      <MegaphoneIcon size={22} className="mt-0.5 shrink-0" />
      <span className="min-w-0">
        <span className="line-clamp-3 font-semibold break-words">{b.body}</span>
        <span className="text-sm opacity-80">
          {b.sentBy ? `${b.sentBy}, ` : ""}
          {since(b.at, now)}
        </span>
      </span>
    </>
  );
  return (
    <div role="status" className="flex items-stretch gap-1 bg-brand text-on-brand shadow-sm">
      {ccHref !== undefined ? (
        <Link href={ccHref} className="flex min-w-0 flex-1 items-start gap-3 py-2.5 pl-4">
          {text}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-3 py-2.5 pl-4">{text}</div>
      )}
      <button type="button" onClick={close} aria-label="Close" className="grid w-12 shrink-0 place-items-center self-stretch">
        <CloseIcon size={22} />
      </button>
    </div>
  );
};
