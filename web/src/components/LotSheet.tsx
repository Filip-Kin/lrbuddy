import type { ReactNode } from "react";
import { lotTitle } from "../lib/format.ts";
import { LotPhotos } from "./photos/LotPhotos.tsx";
import { Sheet } from "./Sheet.tsx";

/**
 * The sheet a lot opens in, for every role: the address as the title, then the
 * role's status control, the crew, the Before and After tiles, and anything
 * else the role adds below.
 */
export const LotSheet = ({
  lot,
  onClose,
  status,
  crew,
  children,
  footer,
  ensureLot,
}: {
  /** `id` is null for a bare parcel (SPEC 21): no lot yet. */
  lot: { id: number | null; address: string | null; parcelId: string | null } | null | undefined;
  onClose: () => void;
  status?: ReactNode;
  crew?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** For a bare parcel: makes it a Todo lot so a Before or After can attach (SPEC 21). Without it a bare parcel shows no tiles. */
  ensureLot?: () => Promise<number>;
}) => (
  <Sheet open={!!lot} onClose={onClose} title={lot ? lotTitle(lot) : "Lot"} footer={footer}>
    {lot && (
      <div className="space-y-4 pb-2">
        {status}
        {crew}
        {(lot.id !== null || ensureLot) && <LotPhotos lotId={lot.id} ensureLot={ensureLot} />}
        {children}
      </div>
    )}
  </Sheet>
);
