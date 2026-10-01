import { useEffect, useState, type ReactNode } from "react";
import type { LotGrade, LotStatus } from "../lib/lotStatus.ts";
import { Button } from "./Button.tsx";
import { TextArea } from "./Field.tsx";
import { LotSheet } from "./LotSheet.tsx";
import { GradeTags, LotStatusControl, targetKey, type LotPatch, type LotTarget } from "./LotStatusControl.tsx";

/** What the sheet shows: a lot, or a bare parcel (`lotId` null, `status` null). */
export interface ParcelView extends LotTarget {
  address: string | null;
  status: LotStatus | null;
  grade: LotGrade | null;
  note: string | null;
}

/**
 * The LotSheet for any parcel (SPEC 21): the five statuses, the size tags
 * while Todo, the crew, photos once there is a lot, and the note. `onNote`
 * makes the note editable (green shirts and admin).
 */
export const ParcelSheet = ({
  parcel,
  onClose,
  onSet,
  canDnt = false,
  canGrade = true,
  error,
  errorFor,
  crew,
  onNote,
  children,
}: {
  parcel: ParcelView | null;
  onClose: () => void;
  onSet: (t: LotTarget, patch: LotPatch) => void;
  canDnt?: boolean;
  canGrade?: boolean;
  error: string | null;
  errorFor: string | null;
  crew?: ReactNode;
  onNote?: (t: LotTarget, note: string | null) => void;
  children?: ReactNode;
}) => {
  const [note, setNote] = useState("");
  const key = parcel ? targetKey(parcel) : null;
  useEffect(() => {
    setNote(parcel?.note ?? "");
    // Reset per parcel; a refetch of the same parcel keeps what is being typed.
  }, [key]);
  const status = parcel?.status ?? "not_todo";
  const locked = !canDnt && status === "do_not_touch";
  return (
    <LotSheet
      lot={parcel ? { id: parcel.lotId, address: parcel.address, parcelId: parcel.parcelId } : null}
      onClose={onClose}
      status={
        parcel && (
          <div className="space-y-3">
            <LotStatusControl status={status} canDnt={canDnt} onChange={(s) => onSet(parcel, { status: s })} />
            {error && errorFor === key && (
              <p role="alert" className="text-sm font-semibold">
                {error}
              </p>
            )}
            {status === "open" && canGrade && !locked && <GradeTags grade={parcel.grade} onChange={(g) => onSet(parcel, { grade: g })} />}
          </div>
        )
      }
      crew={crew}
    >
      {parcel && onNote && parcel.lotId !== null ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            onNote(parcel, note.trim() || null);
          }}
        >
          <TextArea label="Note" value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} />
          {note.trim() !== (parcel.note ?? "").trim() && (
            <Button type="submit" variant="secondary" block>
              Save note
            </Button>
          )}
        </form>
      ) : (
        parcel?.note && <p className="text-sm break-words text-muted">{parcel.note}</p>
      )}
      {children}
    </LotSheet>
  );
};
