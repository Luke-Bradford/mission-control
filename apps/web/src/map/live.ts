import type { MapDelta, MapSnapshot } from "@mc/core";
import { applyDelta } from "./deltas.ts";
import { shareMap } from "./structural.ts";

/** One repo subscription; snapshot requests coalesce while deltas keep their order. */
export class LiveMap {
  /**
   * Refetches driven by deltas and change pings come at most this often; the first load, a
   * reconnect and an error retry are never held. Tests may lower it.
   */
  static REFETCH_GAP_MS = 2000;
  private lastFetch = Number.NEGATIVE_INFINITY;
  private held: ReturnType<typeof setTimeout> | undefined;
  /** A delta during a fetch could not be applied: refetch, throttled, once it lands. */
  private stale = false;
  private source: EventSource | null = null;
  private snapshot: MapSnapshot | null = null;
  private pending: MapDelta[] = [];
  private fetching = false;
  private stopped = false;
  private again = false;
  private watermark = 0;
  private opened = false;
  private epoch = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private repo: string;
  private get: () => Promise<MapSnapshot>;
  private receive: (s: MapSnapshot) => void;
  private error: (e: Error | null) => void;

  constructor(
    repo: string,
    get: () => Promise<MapSnapshot>,
    receive: (s: MapSnapshot) => void,
    error: (e: Error | null) => void,
  ) {
    this.repo = repo;
    this.get = get;
    this.receive = receive;
    this.error = error;
  }

  private hidden = false;
  private active() {
    return !this.stopped && !this.hidden;
  }
  private visibility = () => {
    this.hidden = document.visibilityState === "hidden";
    if (this.hidden) {
      this.source?.close();
      this.source = null;
      clearTimeout(this.retry);
      clearTimeout(this.held);
      this.held = undefined;
      this.pending = [];
      this.watermark = 0;
      this.epoch++;
      this.again = false;
      this.stale = false;
    } else this.connect();
  };
  start() {
    this.hidden = document.visibilityState === "hidden";
    document.addEventListener("visibilitychange", this.visibility);
    this.connect();
  }
  private connect() {
    if (!this.active() || this.source) return;
    this.source = new EventSource(`/api/stream?map=${encodeURIComponent(this.repo)}`);
    this.source.addEventListener("open", () => {
      const first = !this.opened;
      this.opened = true;
      if (!first) {
        this.watermark = 0;
        this.pending = [];
        this.epoch++;
      }
      if (!first || !this.fetching) void this.refresh();
    });
    this.source.addEventListener("error", () =>
      this.error(new Error("Map disconnected; reconnecting…")),
    );
    this.source.addEventListener("changed", (e) => {
      try {
        const { topic } = JSON.parse((e as MessageEvent).data);
        if (["agents", "boards", "config"].includes(topic)) this.invalidate();
      } catch {
        this.invalidate();
      }
    });
    this.source.addEventListener("map", (e) => {
      if (!this.active()) return;
      try {
        const delta = JSON.parse((e as MessageEvent).data) as MapDelta;
        if (!Number.isSafeInteger(delta.seq) || typeof delta.type !== "string")
          throw new Error("Invalid map event");
        if (delta.seq <= this.watermark) return;
        this.watermark = delta.seq;
        if (this.fetching || !this.snapshot) {
          this.pending.push(delta);
          return;
        }
        const next = applyDelta(this.snapshot, delta, Date.now());
        if (next) {
          this.snapshot = next;
          this.receive(next);
        } else this.invalidate();
      } catch {
        this.invalidate();
      }
    });
    void this.refresh();
  }

  async refresh() {
    if (!this.active()) return;
    if (this.fetching) {
      this.again = true;
      return;
    }
    clearTimeout(this.retry);
    clearTimeout(this.held);
    this.held = undefined;
    this.lastFetch = Date.now();
    this.fetching = true;
    const epoch = this.epoch;
    try {
      let snapshot: MapSnapshot = await this.get();
      if (!this.active()) return;
      if (epoch !== this.epoch) {
        this.again = true;
        return;
      }
      for (const delta of this.pending) {
        const next: MapSnapshot | null = applyDelta(snapshot, delta, Date.now());
        if (next) snapshot = next;
        else this.stale = true;
      }
      this.pending = [];
      snapshot = shareMap(this.snapshot ?? undefined, snapshot);
      this.snapshot = snapshot;
      this.watermark = Math.max(this.watermark, snapshot.seq);
      this.receive(snapshot);
      this.error(null);
    } catch (e) {
      if (this.active()) {
        this.error(e instanceof Error ? e : new Error("Map unavailable"));
        this.retry = setTimeout(() => {
          void this.refresh();
        }, 5000);
      }
    } finally {
      this.fetching = false;
      if (this.again && this.active()) {
        this.again = false;
        this.stale = false;
        clearTimeout(this.retry);
        this.retry = setTimeout(() => {
          void this.refresh();
        }, 0);
      } else if (this.stale && this.active()) {
        this.stale = false;
        this.invalidate();
      }
    }
  }

  /** A refetch asked for by a delta or a change ping: now, or once the gap since the last has passed. */
  private invalidate() {
    if (this.stopped || this.held !== undefined) return;
    const wait = this.lastFetch + LiveMap.REFETCH_GAP_MS - Date.now();
    if (wait <= 0 && !this.fetching) {
      void this.refresh();
      return;
    }
    this.held = setTimeout(
      () => {
        this.held = undefined;
        void this.refresh();
      },
      Math.max(0, wait),
    );
  }

  stop() {
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.visibility);
    clearTimeout(this.retry);
    clearTimeout(this.held);
    this.source?.close();
  }
}
