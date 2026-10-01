/** What a route shows while its code chunk downloads. `dark` for the camera screen. */
export const ScreenLoading = ({ dark }: { dark?: boolean }) => (
  <div className={`grid h-full min-h-48 place-items-center ${dark ? "bg-black text-white/70" : "text-muted"}`} aria-busy="true" data-screen-loading>
    <span className="text-sm font-semibold">Loading…</span>
  </div>
);
