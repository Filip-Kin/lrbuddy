/** Quiet loading placeholder: grey blocks in the shape of what is coming. */
export const Skeleton = ({ className = "" }: { className?: string }) => (
  <div aria-hidden="true" className={`animate-pulse rounded-2xl bg-surface-2 ${className}`} />
);

export const SkeletonList = ({ rows = 3, className = "h-24" }: { rows?: number; className?: string }) => (
  <div aria-busy="true" className="space-y-3">
    {Array.from({ length: rows }, (_, i) => (
      <Skeleton key={i} className={className} />
    ))}
  </div>
);
