/** True when a portal query failed because no event is active. */
export const noEvent = (err: unknown): boolean =>
  typeof err === "object" && err !== null && "data" in err && (err as { data?: { code?: unknown } | null }).data?.code === "PRECONDITION_FAILED";
