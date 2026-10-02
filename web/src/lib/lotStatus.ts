import type { LotGrade, LotStatus } from "../../../server/db/schema.ts";

export type { LotGrade, LotStatus };

/**
 * SPEC 21: one set of words for a parcel's status, everywhere, in this order.
 * `none` is a parcel with no lot row, which reads as Not todo.
 */
export const STATUS_ORDER: readonly LotStatus[] = ["not_todo", "open", "in_progress", "done", "do_not_touch"];

export const STATUS_LABEL: Record<LotStatus, string> = {
  not_todo: "Not todo",
  open: "Todo",
  in_progress: "In progress",
  done: "Done",
  do_not_touch: "Do not touch",
};

/** Survey grade on a Todo lot. */
export const GRADE_LABEL: Record<LotGrade, string> = { high: "Full day", low: "Light" };
