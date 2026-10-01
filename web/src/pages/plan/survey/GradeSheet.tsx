import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button.tsx";
import { TextArea } from "../../../components/Field.tsx";
import { CameraIcon, RetryIcon } from "../../../components/photos/icons.tsx";
import { PhotoSlot } from "../../../components/photos/PhotoSlot.tsx";
import { PhotoViewer } from "../../../components/photos/PhotoViewer.tsx";
import { Segmented } from "../../../components/Segmented.tsx";
import { Sheet } from "../../../components/Sheet.tsx";
import { Skeleton } from "../../../components/Skeleton.tsx";
import { errorText } from "../../../lib/errors.ts";
import { dateTime } from "../../../lib/format.ts";
import { usePhotoUpload } from "../../../lib/photos.ts";
import { trpc } from "../../../lib/trpc.ts";
import { GRADE_LABEL, GRADES, type Grade } from "./style.ts";

export interface SheetParcel {
  parcelId: string;
  address: string | null;
  grade: Grade | null;
  note?: string | null;
}

// #region photo
const tile = "aspect-[4/3] w-full rounded-2xl";

/** The first photo of a parcel with no lot yet: the lot is made, then this file goes up. */
const FirstUpload = ({ lotId, file, onDone }: { lotId: number; file: File; onDone: () => void }) => {
  const up = usePhotoUpload(lotId, "before");
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void up.pick(file);
  }, [up, file]);
  const st = up.state;
  useEffect(() => {
    if (st.phase === "done") onDone();
  }, [st.phase, onDone]);
  const preview = st.phase === "idle" ? null : st.preview;
  return (
    <div className="min-w-0">
      <div className={`relative overflow-hidden bg-surface-2 ring-1 ring-line ${tile}`}>
        {preview && <img src={preview} alt="" className={`h-full w-full object-cover ${st.phase === "failed" ? "opacity-50" : ""}`} />}
        <span className="absolute top-1.5 left-1.5 rounded-full bg-black/65 px-2 py-0.5 text-xs font-semibold text-white">Before</span>
        {st.phase === "working" && (
          <div className="absolute inset-x-1.5 bottom-1.5">
            <div role="progressbar" aria-label="Before upload" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(st.progress * 100)} className="h-2 overflow-hidden rounded-full bg-black/40">
              <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${Math.max(4, st.progress * 100)}%` }} />
            </div>
          </div>
        )}
        {st.phase === "failed" && (
          <div className="absolute inset-0 grid place-items-center">
            <button type="button" data-camera onClick={() => void up.retry()} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand px-3 text-sm font-semibold text-on-brand shadow">
              <RetryIcon size={18} />
              Retry
            </button>
          </div>
        )}
      </div>
      {st.phase === "failed" && (
        <p role="alert" className="mt-1 text-sm font-semibold">
          {st.message}
        </p>
      )}
    </div>
  );
};

/** Before photo for a surveyed parcel, through the lot photo upload (SPEC 15). */
const SurveyPhoto = ({ parcelId, address }: { parcelId: string; address: string | null }) => {
  const utils = trpc.useUtils();
  const lotQ = trpc.plan.survey.lotOf.useQuery({ parcelId });
  const lotId = lotQ.data?.lotId ?? null;
  const photosQ = trpc.shared.lotPhotos.useQuery({ lotId: lotId ?? 0 }, { enabled: lotId !== null });
  const makeLot = trpc.plan.survey.lotForPhoto.useMutation();
  const [pending, setPending] = useState<{ lotId: number; file: File } | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef<() => void>(() => undefined);
  done.current = () => {
    setPending(null);
    void utils.plan.survey.lotOf.invalidate({ parcelId });
    void utils.shared.lotPhotos.invalidate();
  };

  if (pending) return <FirstUpload lotId={pending.lotId} file={pending.file} onDone={() => done.current()} />;
  if (lotQ.isLoading || (lotId !== null && photosQ.isLoading)) return <Skeleton className={tile} />;
  if (lotId !== null && photosQ.data) {
    const newest = photosQ.data.photos.find((p) => p.kind === "before")?.id ?? null;
    return (
      <>
        <PhotoSlot lotId={lotId} kind="before" photoId={newest} canAdd={photosQ.data.canAdd} onOpen={setViewing} address={address ?? undefined} />
        {viewing !== null && <PhotoViewer lotId={lotId} startId={viewing} onClose={() => setViewing(null)} />}
      </>
    );
  }
  return (
    <div className="min-w-0">
      <button
        type="button"
        data-camera
        disabled={makeLot.isPending}
        onClick={() => input.current?.click()}
        aria-label={`Before photo${address ? `, ${address}` : ""}`}
        className={`flex flex-col items-center justify-center gap-1 border-2 border-dashed border-line bg-surface-2 text-base font-semibold text-ink active:brightness-95 ${tile}`}
      >
        <CameraIcon size={28} />
        Before
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        data-camera-input="before"
        aria-label="Before photo"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setError(null);
          makeLot.mutate(
            { parcelId },
            {
              onSuccess: (r) => setPending({ lotId: r.lotId, file: f }),
              onError: (err) => setError(errorText(err, "Photo not sent. Try again.")),
            },
          );
        }}
      />
      {error && (
        <p role="alert" className="mt-1 text-sm font-semibold">
          {error}
        </p>
      )}
    </div>
  );
};
// #endregion

// #region history
const History = ({ parcelId }: { parcelId: string }) => {
  const q = trpc.plan.survey.history.useQuery({ parcelId });
  if (q.isLoading) return <Skeleton className="h-16" />;
  const rows = q.data ?? [];
  if (rows.length === 0) return null;
  return (
    <section aria-label="History">
      <h3 className="mb-1.5 text-sm font-semibold">History</h3>
      <ul className="divide-y divide-line rounded-xl bg-surface-2 px-3 text-sm">
        {rows.slice(0, 6).map((t) => (
          <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
            <span className="font-semibold">{GRADE_LABEL[t.grade]}</span>
            <span className="text-muted">
              {t.by}, {dateTime(t.at)}
            </span>
            {t.note && <span className="w-full break-words">{t.note}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
};
// #endregion

/**
 * Grade one parcel: High, Low or Clear, a note, a before photo. Used by the
 * laptop survey map and by a long press in drive mode.
 */
export const GradeSheet = ({
  parcel,
  onClose,
  onSave,
  busy,
  error,
  showHistory,
}: {
  parcel: SheetParcel | null;
  onClose: () => void;
  onSave: (grade: Grade, note: string | null) => void;
  busy?: boolean;
  error?: string | null;
  showHistory?: boolean;
}) => {
  const [grade, setGrade] = useState<Grade>("low");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!parcel) return;
    setGrade(parcel.grade ?? "low");
    setNote(parcel.note ?? "");
  }, [parcel?.parcelId]);
  return (
    <Sheet
      open={parcel !== null}
      onClose={onClose}
      title={parcel?.address ?? "Parcel"}
      footer={
        <Button block size="lg" busy={busy} onClick={() => onSave(grade, note.trim() || null)}>
          Save
        </Button>
      }
    >
      {parcel && (
        <div className="space-y-4 pb-2">
          <Segmented label="Grade" size="lg" value={grade} onChange={setGrade} options={GRADES.map((g) => ({ value: g, label: GRADE_LABEL[g] }))} />
          <TextArea label="Note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} />
          <div className="grid grid-cols-2 gap-3">
            <SurveyPhoto parcelId={parcel.parcelId} address={parcel.address} />
          </div>
          {showHistory && <History parcelId={parcel.parcelId} />}
          {error && (
            <p role="alert" className="text-sm font-semibold">
              {error}
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
};
