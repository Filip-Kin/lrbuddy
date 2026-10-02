/**
 * Preloaded into the seed and the server for the e2e run (`bun --preload`). Replaces the global
 * fetch: ArcGIS, Overpass, OSRM and the World Imagery tiles get answers from fake-world.ts, loopback
 * passes through, and anything else fails as if the network were down. Every blocked request is
 * logged with the "[e2e offline]" prefix so the runner can report it.
 */
import { encode } from "jpeg-js";
import { fakeAnswer } from "./fake-world.ts";

const real = globalThis.fetch;
let tile: Uint8Array<ArrayBuffer> | null = null;

/** A 256 px tile of plain ground colour for the seeded before and after photos. */
const jpeg = (): Uint8Array<ArrayBuffer> => {
  if (tile) return tile;
  const w = 256;
  const data = new Uint8Array(w * w * 4);
  for (let i = 0; i < w * w; i++) {
    const x = i % w;
    const y = Math.floor(i / w);
    data[i * 4] = 96 + ((x * 7 + y * 3) % 40);
    data[i * 4 + 1] = 120 + ((x * 5 + y * 11) % 50);
    data[i * 4 + 2] = 80;
    data[i * 4 + 3] = 255;
  }
  tile = new Uint8Array(encode({ data, width: w, height: w }, 70).data);
  return tile;
};

const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (LOCAL.has(url.hostname)) return real(input, init);
  const answer = await fakeAnswer(url, init, jpeg);
  if (answer) return answer;
  console.error(`[e2e offline] blocked ${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
  throw new TypeError(`e2e offline: ${url.hostname} is not reachable`);
};

globalThis.fetch = Object.assign(fake, { preconnect: real.preconnect }) as typeof fetch;
