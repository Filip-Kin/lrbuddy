import { Skeleton as Block } from "../Skeleton.tsx";

/** Stock rows while they load. */
export const StockSkeleton = () => (
  <div className="space-y-2" aria-busy="true">
    {Array.from({ length: 6 }, (_, i) => (
      <Block key={i} className="h-20" />
    ))}
  </div>
);
