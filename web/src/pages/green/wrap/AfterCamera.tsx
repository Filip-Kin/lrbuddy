import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "../../../components/photos/icons.tsx";
import { LensSwitch } from "../flag/LensSwitch.tsx";
import { grabFrame, useCamera } from "../flag/sensors.ts";

/**
 * Wrap up's After camera (SPEC 28): the Flag screen's in-app camera full screen, with the same
 * lens switch, for one lot. One shutter press hands the frame back and closes; the upload runs
 * behind the list. Close returns with no photo.
 */
export const AfterCamera = ({ title, onShot, onClose }: { title: string; onShot: (blobs: { photo: Blob; thumb: Blob }) => void; onClose: () => void }) => {
  const camera = useCamera();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const [busy, setBusy] = useState(false);
  const shoot = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const blobs = await grabFrame(camera);
    setBusy(false);
    if (blobs) onShot(blobs);
  };
  const ready = camera.state === "on";
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={`After, ${title}`} className="fixed inset-0 z-[2100] flex flex-col bg-black text-white" data-after-camera>
      <div className="relative min-h-0 flex-1">
        <video ref={camera.video} muted playsInline autoPlay className="absolute inset-0 h-full w-full object-cover" aria-label="Camera" />
        {!ready && <div aria-hidden="true" className="absolute inset-0 bg-[#0e3038]" />}
        <div className="absolute inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-10 flex items-start gap-2">
          <div className="min-w-0 flex-1 rounded-xl bg-black/65 px-3 py-2">
            <p className="text-base leading-tight font-bold break-words" data-after-title>
              {title}
            </p>
            <div className="mt-1 flex flex-wrap gap-1.5 text-xs font-semibold">
              <span className="rounded-full bg-white/20 px-2 py-0.5">After</span>
              {(camera.state === "denied" || camera.state === "none") && <span className="rounded-full bg-[#e55b00] px-2 py-0.5">No camera</span>}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-black/75 text-white shadow-lg ring-2 ring-white/70"
            data-after-close
          >
            <CloseIcon size={24} />
          </button>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 bg-black px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <span aria-hidden="true" className="w-28 shrink-0" />
        <button
          type="button"
          disabled={!ready || busy}
          onClick={() => void shoot()}
          className="grid h-[88px] w-[88px] shrink-0 place-items-center rounded-full border-4 border-white bg-[#00a14b] text-lg font-black shadow-lg active:scale-95 disabled:opacity-40"
          data-after-shutter
        >
          After
        </button>
        <LensSwitch camera={camera} />
      </div>
    </div>,
    document.body,
  );
};
