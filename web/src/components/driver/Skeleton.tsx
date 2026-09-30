const Block = ({ className }: { className: string }) => <div className={`animate-pulse rounded-2xl bg-surface-2 ${className}`} />;

/** Quiet placeholder while the queue loads: the shape of a stop card and two rows. */
export const QueueSkeleton = () => (
  <div className="space-y-4" aria-busy="true">
    <div className="space-y-4 rounded-3xl p-4 ring-1 ring-line">
      <Block className="h-4 w-24" />
      <Block className="h-8 w-40" />
      <div className="grid grid-cols-3 gap-2">
        <Block className="h-14" />
        <Block className="h-14" />
        <Block className="h-14" />
      </div>
      <Block className="h-24" />
      <div className="grid grid-cols-2 gap-2">
        <Block className="h-14" />
        <Block className="h-14" />
      </div>
    </div>
    <Block className="h-16" />
    <Block className="h-16" />
  </div>
);

/** Stock rows while they load. */
export const StockSkeleton = () => (
  <div className="space-y-2" aria-busy="true">
    {Array.from({ length: 6 }, (_, i) => (
      <Block key={i} className="h-20" />
    ))}
  </div>
);
