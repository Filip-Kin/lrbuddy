import { desc, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import { clientErrors, type ClientError } from "./db/schema.ts";

/**
 * Browser crash reports (`POST /client-error`): the error boundary, `window.onerror` and
 * unhandled rejections post here, so a blank screen in the field leaves a row and a log line.
 */

// #region rate limit
/** Per client address: a crash loop on one phone must not fill the table or the log. */
export const CLIENT_ERROR_LIMIT = 10;
export const CLIENT_ERROR_WINDOW_MS = 60_000;
/** Rows kept; older ones go when a new one arrives. */
export const CLIENT_ERROR_KEEP = 2000;

const hits = new Map<string, number[]>();

export const allowClientError = (key: string, now = Date.now()): boolean => {
  const list = (hits.get(key) ?? []).filter((t) => now - t < CLIENT_ERROR_WINDOW_MS);
  if (list.length >= CLIENT_ERROR_LIMIT) {
    hits.set(key, list);
    return false;
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= CLIENT_ERROR_WINDOW_MS)) hits.delete(k);
  }
  return true;
};

/** Tests only. */
export const resetClientErrorLimit = (): void => hits.clear();
// #endregion

// #region record
const text = (max: number) =>
  z
    .string()
    .transform((v) => v.slice(0, max))
    .nullish();

export const clientErrorBody = z.object({
  message: z.string().min(1).transform((v) => v.slice(0, 1000)),
  stack: text(8000),
  url: text(500),
  userAgent: text(400),
  role: text(20),
});
export type ClientErrorBody = z.input<typeof clientErrorBody>;

/** Stores one report and prints one line. `sessionRole` wins over the role the page claims. */
export const recordClientError = (body: unknown, sessionRole: string | null, now = Date.now()): ClientError | null => {
  const parsed = clientErrorBody.safeParse(body);
  if (!parsed.success) return null;
  const b = parsed.data;
  const row = db
    .insert(clientErrors)
    .values({ at: now, message: b.message, stack: b.stack ?? null, url: b.url ?? null, userAgent: b.userAgent ?? null, role: sessionRole ?? b.role ?? null })
    .returning()
    .get();
  if (row.id > CLIENT_ERROR_KEEP) db.delete(clientErrors).where(lt(clientErrors.id, row.id - CLIENT_ERROR_KEEP + 1)).run();
  const firstLine = b.message.split("\n")[0]!.slice(0, 200);
  console.error(`[client-error] ${row.role ?? "anon"} ${b.url ?? "?"}: ${firstLine}`);
  return row;
};

/** Newest first. */
export const recentClientErrors = (limit = 200): ClientError[] => db.select().from(clientErrors).orderBy(desc(clientErrors.id)).limit(limit).all();
// #endregion

// #region route
/** `POST /client-error`: 204 stored, 400 unreadable, 413 too big, 429 over the limit. */
export const handleClientError = async (req: Request, ip: string, sessionRole: string | null): Promise<Response> => {
  if (!allowClientError(ip)) return new Response(null, { status: 429 });
  const raw = await req.text().catch(() => "");
  if (raw.length > 20_000) return new Response(null, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }
  return recordClientError(body, sessionRole) ? new Response(null, { status: 204 }) : new Response(null, { status: 400 });
};
// #endregion
