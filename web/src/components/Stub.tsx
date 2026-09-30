import { EmptyState } from "./EmptyState.tsx";

/** Placeholder a role agent replaces with the real screen. */
export const Stub = ({ label }: { label: string }) => (
  <div className="mx-auto w-full max-w-2xl px-4 py-4">
    <EmptyState title={label} />
  </div>
);
