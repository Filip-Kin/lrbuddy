import { useEffect, useState } from "react";

/** Current time, refreshed every `everyMs`, so relative times ("4 min ago") keep moving. */
export const useNow = (everyMs = 30_000): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
};
