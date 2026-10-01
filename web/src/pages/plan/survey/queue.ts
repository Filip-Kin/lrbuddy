/**
 * Drive mode's outbox. Tags and undos post one at a time, in the order they
 * were made. A lost connection keeps them queued and retries; a refusal from
 * the server drops that one entry and reports it. Memory only: a reload
 * empties it.
 */

export interface TagInput {
  parcelId: string;
  grade: "high" | "low" | "clear";
  side: "left" | "right" | "tap";
  note?: string | null;
  lat?: number | null;
  lng?: number | null;
  heading?: number | null;
  at: number;
}

export type Op = { kind: "tag"; localId: number; input: TagInput } | { kind: "undo"; localId: number };

export interface QueueDeps {
  sendTag: (input: TagInput) => Promise<{ tagId: number }>;
  sendUndo: (tagId: number) => Promise<void>;
  /** True when the error means the server answered (drop the entry), false for a lost connection (keep it). */
  isRefusal: (err: unknown) => boolean;
  onRefused?: (op: Op, err: unknown) => void;
  onChange?: () => void;
  /** Delay before a retry, by attempt number from 1. */
  backoffMs?: (attempt: number) => number;
}

export class TagQueue {
  private ops: Op[] = [];
  private sent = new Map<number, number>();
  private nextId = 1;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** True while the head of the queue is waiting to retry after a lost connection. */
  stalled = false;

  constructor(private deps: QueueDeps) {}

  /** Entries not yet accepted by the server. */
  get pending(): number {
    return this.ops.length;
  }

  /** Server id of a tag once it has posted. */
  tagIdOf(localId: number): number | null {
    return this.sent.get(localId) ?? null;
  }

  tag(input: TagInput): number {
    const localId = this.nextId++;
    this.ops.push({ kind: "tag", localId, input });
    this.changed();
    void this.run();
    return localId;
  }

  /**
   * Takes a tag back. Still queued and not in flight: it never posts. Posted
   * or in flight: an undo queues behind it.
   */
  undo(localId: number): void {
    const i = this.ops.findIndex((o) => o.kind === "tag" && o.localId === localId);
    if (i > 0 || (i === 0 && !this.running)) {
      this.ops.splice(i, 1);
      this.changed();
      return;
    }
    this.ops.push({ kind: "undo", localId });
    this.changed();
    void this.run();
  }

  /** Retry now (the browser came back online). */
  kick(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    void this.run();
  }

  /** Swaps the change and refusal callbacks (React mounts them after the queue exists). */
  listen(h: Pick<QueueDeps, "onChange" | "onRefused">): void {
    this.deps.onChange = h.onChange;
    this.deps.onRefused = h.onRefused;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deps.onChange = undefined;
  }

  private changed(): void {
    this.deps.onChange?.();
  }

  private async run(): Promise<void> {
    if (this.running || this.timer) return;
    this.running = true;
    try {
      while (this.ops.length > 0) {
        const op = this.ops[0]!;
        try {
          if (op.kind === "tag") {
            const r = await this.deps.sendTag(op.input);
            this.sent.set(op.localId, r.tagId);
          } else {
            const tagId = this.sent.get(op.localId);
            if (tagId !== undefined) {
              await this.deps.sendUndo(tagId);
              this.sent.delete(op.localId);
            }
          }
          this.ops.shift();
          this.attempt = 0;
          this.stalled = false;
          this.changed();
        } catch (err) {
          if (this.deps.isRefusal(err)) {
            this.ops.shift();
            this.deps.onRefused?.(op, err);
            this.changed();
            continue;
          }
          this.attempt++;
          this.stalled = true;
          this.changed();
          const wait = (this.deps.backoffMs ?? ((n: number) => Math.min(15_000, 1000 * 2 ** n)))(this.attempt);
          this.timer = setTimeout(() => {
            this.timer = null;
            void this.run();
          }, wait);
          return;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
