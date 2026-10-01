/**
 * ETags on tRPC query answers (GET, JSON, 200). The answer is hashed; a request whose
 * `If-None-Match` matches gets a bodyless 304, so a phone refetching the CC's parcels after a
 * lot change that did not touch them downloads a few hundred bytes instead of the whole list.
 * `private, max-age=0, must-revalidate` keeps every answer per browser and always checked with
 * the server, which recomputes it for the session in the cookie.
 */
export const REVALIDATE = "private, max-age=0, must-revalidate";

/** Strong and weak forms both match: a compressing proxy may weaken the tag on the way out. */
const tagMatches = (header: string | null, tag: string): boolean => {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === tag);
};

export const withEtag = async (req: Request, res: Response): Promise<Response> => {
  if (req.method !== "GET" || res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("application/json")) return res;
  const body = new Uint8Array(await res.arrayBuffer());
  const tag = `"${Bun.hash(body).toString(36)}-${body.length.toString(36)}"`;
  const headers = new Headers(res.headers);
  headers.set("etag", tag);
  headers.set("cache-control", REVALIDATE);
  if (tagMatches(req.headers.get("if-none-match"), tag)) {
    headers.delete("content-type");
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
};
