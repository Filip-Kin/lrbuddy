/** Quiet loading placeholder: a grey block in the shape of what is coming. */
export const Skeleton = ({ className = "" }: { className?: string }) => (
  <div aria-hidden="true" className={`animate-pulse rounded-2xl bg-surface-2 ${className}`} />
);

/** A few card-shaped blocks, for a list that is loading. */
export const SkeletonList = ({ rows = 3, className = "h-24" }: { rows?: number; className?: string }) => (
  <div aria-busy="true" aria-label="Loading" className="space-y-3">
    {Array.from({ length: rows }, (_, i) => (
      <Skeleton key={i} className={className} />
    ))}
  </div>
);
