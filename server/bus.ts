import { EventEmitter, on } from "node:events";
import type { Broadcast, Lot, Request, Route, TruckStock } from "./db/schema.ts";

/** Payloads for every event in SPEC section 6. */
export interface BusPayloads {
  "request.changed": { request: Request };
  "truck.position": { truckId: number; lat: number; lng: number; at: number };
  "crew.position": { crewId: number; lat: number; lng: number; at: number };
  "route.changed": { truckId: number; route: Route | null };
  "lot.changed": { lot: Lot };
  "stock.changed": { truckId: number; stock: TruckStock[] };
  broadcast: { broadcast: Broadcast };
}

export type BusEventType = keyof BusPayloads;

export type BusMessage = {
  [K in BusEventType]: { type: K; ccId: number | null; dayId: number | null; payload: BusPayloads[K] };
}[BusEventType];

const CHANNEL = "msg";

class Bus {
  private readonly ee = new EventEmitter();

  constructor() {
    // One listener per open SSE stream; a busy day has hundreds.
    this.ee.setMaxListeners(0);
  }

  emit<K extends BusEventType>(type: K, scope: { ccId: number | null; dayId: number | null }, payload: BusPayloads[K]): void {
    const msg = { type, ccId: scope.ccId, dayId: scope.dayId, payload } as BusMessage;
    this.ee.emit(CHANNEL, msg);
  }

  subscribe(fn: (msg: BusMessage) => void): () => void {
    this.ee.on(CHANNEL, fn);
    return () => this.ee.off(CHANNEL, fn);
  }

  /** Async iterator of every message until `signal` aborts. */
  async *listen(signal: AbortSignal | undefined): AsyncGenerator<BusMessage> {
    try {
      for await (const args of on(this.ee, CHANNEL, { signal })) {
        yield (args as [BusMessage])[0];
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      throw err;
    }
  }
}

export const bus = new Bus();
