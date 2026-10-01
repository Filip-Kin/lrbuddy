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

/**
 * Internal, never sent to a client: something may have ended a session or
 * moved it to another CC. Every open stream reads its scope again.
 */
export type ScopeCheck = { type: "scope.check" };

/** What travels on the emitter: the public events plus scope checks. */
export type WireMessage = BusMessage | ScopeCheck;

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

  /**
   * Tells every open stream to read its session again. Call after anything
   * that deletes a session or changes the CC a session follows. Delivered in
   * order with the other events, so nothing emitted later reaches a stream
   * before it has re-read its scope.
   */
  checkScopes(): void {
    this.ee.emit(CHANNEL, { type: "scope.check" } satisfies ScopeCheck);
  }

  /** Public events only. */
  subscribe(fn: (msg: BusMessage) => void): () => void {
    const handler = (msg: WireMessage): void => {
      if (msg.type !== "scope.check") fn(msg);
    };
    this.ee.on(CHANNEL, handler);
    return () => this.ee.off(CHANNEL, handler);
  }

  /** Async iterator of every message, scope checks included, until `signal` aborts. */
  async *listen(signal: AbortSignal | undefined): AsyncGenerator<WireMessage> {
    try {
      for await (const args of on(this.ee, CHANNEL, { signal })) {
        yield (args as [WireMessage])[0];
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      throw err;
    }
  }
}

export const bus = new Bus();
