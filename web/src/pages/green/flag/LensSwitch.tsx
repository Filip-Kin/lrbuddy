import type { Camera } from "./sensors.ts";

/**
 * Wide / Normal right of a camera shutter (SPEC 22, lens), on the Flag screen and Wrap up's After
 * camera. With no ultra-wide on the phone, an empty slot of the same width keeps the shutter centred.
 */
export const LensSwitch = ({ camera }: { camera: Pick<Camera, "canSwitch" | "lens" | "setLens"> }) =>
  camera.canSwitch ? (
    <div role="group" aria-label="Lens" className="flex w-28 shrink-0 rounded-full bg-white/10 p-1 ring-2 ring-white/70" data-flag-lens>
      {(["wide", "normal"] as const).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={camera.lens === l}
          onClick={() => camera.setLens(l)}
          className={`min-h-11 min-w-0 flex-1 rounded-full text-[13px] font-bold ${camera.lens === l ? "bg-white text-[#0e3038]" : "text-white"}`}
          data-flag-lens-option={l}
        >
          {l === "wide" ? "Wide" : "Normal"}
        </button>
      ))}
    </div>
  ) : (
    <span aria-hidden="true" className="w-28 shrink-0" />
  );
