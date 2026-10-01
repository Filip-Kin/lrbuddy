import { useRef } from "react";
import { KIND_LABEL, photoUrl, usePhotoUpload, type LotRef, type PhotoKind } from "../../lib/photos.ts";
import { CameraIcon, RetryIcon } from "./icons.tsx";

/**
 * One kind of photo for one lot: the newest thumb (tap opens the viewer), or a
 * camera button. `tile` is the large square in the lot sheet, with a second
 * camera button for another shot; `inline` is the small pair in a crew lot row.
 * While uploading it shows the shot with a progress bar; a failed upload keeps
 * the shot with Retry.
 */
export const PhotoSlot = ({
  lotId,
  kind,
  photoId,
  canAdd,
  onOpen,
  size = "tile",
  address,
}: {
  /** The lot, or for a bare parcel a function that creates it on the first photo. */
  lotId: LotRef;
  kind: PhotoKind;
  /** Newest live photo of this kind, or null. */
  photoId: number | null;
  canAdd: boolean;
  onOpen: (photoId: number) => void;
  size?: "tile" | "inline";
  /** Names the lot in accessible names, where several rows sit on one page. */
  address?: string;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const up = usePhotoUpload(lotId, kind);
  const label = KIND_LABEL[kind];
  const of = address ? `, ${address}` : "";
  const open = (): void => input.current?.click();
  const st = up.state;
  // The local shot stands in until the server's newest photo is the one just sent.
  const local = st.phase === "working" || st.phase === "failed" || (st.phase === "done" && photoId !== st.id) ? st.preview : null;
  const tile = size === "tile";
  const box = tile ? "aspect-[4/3] w-full rounded-2xl" : "h-16 w-[5.5rem] rounded-xl";

  const picker = (
    <input
      ref={input}
      type="file"
      accept="image/*"
      capture="environment"
      className="hidden"
      data-camera-input={kind}
      aria-label={`${label} photo${of}`}
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) void up.pick(f);
      }}
    />
  );

  const caption = (
    <span className={`absolute top-1.5 left-1.5 rounded-full bg-black/65 px-2 py-0.5 font-semibold text-white ${tile ? "text-xs" : "text-[11px]"}`}>{label}</span>
  );

  if (local) {
    const failed = st.phase === "failed";
    return (
      <div className={tile ? "min-w-0" : "flex min-w-0 flex-col gap-1"}>
        <div className={`relative overflow-hidden bg-surface-2 ring-1 ring-line ${box}`}>
          <img src={local} alt="" className={`h-full w-full object-cover ${failed ? "opacity-50" : ""}`} />
          {caption}
          {st.phase === "working" && (
            <div className="absolute inset-x-1.5 bottom-1.5">
              <div
                role="progressbar"
                aria-label={`${label} upload${of}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(st.progress * 100)}
                className="h-2 overflow-hidden rounded-full bg-black/40"
              >
                <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${Math.max(4, st.progress * 100)}%` }} />
              </div>
            </div>
          )}
          {failed && (
            <div className="absolute inset-0 grid place-items-center p-1.5">
              <button
                type="button"
                data-camera
                onClick={() => (st.message === "Photo not readable" ? open() : void up.retry())}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand px-3 text-sm font-semibold text-on-brand shadow"
                aria-label={`Retry ${label.toLowerCase()} photo${of}`}
              >
                <RetryIcon size={18} />
                Retry
              </button>
            </div>
          )}
        </div>
        {failed && (
          <p role="alert" className={`font-semibold text-ink ${tile ? "mt-1 text-sm" : "max-w-[5.5rem] text-xs leading-tight"}`}>
            {st.message}
          </p>
        )}
        {picker}
      </div>
    );
  }

  if (photoId !== null) {
    return (
      <div className="relative min-w-0">
        <button
          type="button"
          onClick={() => onOpen(photoId)}
          aria-label={`${label} photo${of}`}
          className={`relative block overflow-hidden bg-surface-2 ring-1 ring-line ${box}`}
        >
          <img src={photoUrl(photoId, true)} alt="" loading="lazy" className="h-full w-full object-cover" />
          {caption}
        </button>
        {tile && canAdd && (
          <button
            type="button"
            data-camera
            onClick={open}
            aria-label={`New ${label.toLowerCase()} photo${of}`}
            className="absolute right-1.5 bottom-1.5 grid h-11 w-11 place-items-center rounded-full bg-brand text-on-brand shadow-md"
          >
            <CameraIcon size={20} />
          </button>
        )}
        {picker}
      </div>
    );
  }

  if (!canAdd) {
    return (
      <div className={`grid place-items-center border-2 border-dashed border-line text-center font-semibold text-muted ${box} ${tile ? "text-sm" : "text-xs"}`}>
        {`No ${label.toLowerCase()}`}
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        data-camera
        onClick={open}
        aria-label={`${label} photo${of}`}
        className={`flex flex-col items-center justify-center gap-1 border-2 border-dashed border-line bg-surface-2 font-semibold text-ink active:brightness-95 ${box} ${tile ? "text-base" : "text-sm"}`}
      >
        <CameraIcon size={tile ? 28 : 22} />
        {label}
      </button>
      {picker}
    </div>
  );
};
