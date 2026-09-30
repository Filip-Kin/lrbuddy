/**
 * The message of a failed tRPC call when it is one of ours (short, in the
 * reader's terms); otherwise the fallback. Browser network errors ("Failed to
 * fetch") and zod dumps never reach the screen.
 */
export const errorText = (err: unknown, fallback = "Not saved. Try again."): string => {
  if (typeof err === "object" && err !== null && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string" && m.length > 0 && m.length < 120 && !/fetch|network|load failed/i.test(m) && !m.startsWith("[")) return m;
  }
  return fallback;
};
