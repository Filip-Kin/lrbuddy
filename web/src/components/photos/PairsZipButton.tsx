import { useState } from "react";
import { buildPairsZip, saveBlob, type PairsZipLot } from "../../lib/pairsZip.ts";
import { DownloadIcon } from "../admin/icons.tsx";
import { Button } from "../Button.tsx";

/**
 * "Pairs zip" (SPEC 15): asks the server which lots have both photos, builds the side by sides
 * and the raw photos into a zip in the browser and saves it. Shows lots done while it builds.
 */
export const PairsZipButton = ({ load, variant = "secondary" }: { load: () => Promise<readonly PairsZipLot[]>; variant?: "primary" | "secondary" }) => {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (): Promise<void> => {
    setError(null);
    setProgress({ done: 0, total: 0 });
    try {
      const lots = await load();
      if (lots.length === 0) {
        setError("No pairs");
        return;
      }
      const blob = await buildPairsZip(lots, (done, total) => setProgress({ done, total }));
      const stamp = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Detroit" });
      saveBlob(blob, `lrbuddy-pairs-${stamp}.zip`);
    } catch (e) {
      setError(e instanceof Error && e.message.length < 80 ? e.message : "Zip not built");
    } finally {
      setProgress(null);
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <Button variant={variant} busy={progress !== null} onClick={() => void run()} data-pairs-zip>
        <DownloadIcon />
        {progress && progress.total > 0 ? `Pairs zip ${progress.done}/${progress.total}` : "Pairs zip"}
      </Button>
      {error && (
        <span role="alert" className="text-sm font-semibold" data-pairs-zip-error>
          {error}
        </span>
      )}
    </span>
  );
};
