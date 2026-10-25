import type { MapDelta, MapSnapshot } from "@mc/core";
import { applyDelta } from "./model.ts";

/** One repo subscription; snapshot requests coalesce while deltas keep their order. */
export class LiveMap {
  private source: EventSource | null = null;
  private snapshot: MapSnapshot | null = null;
  private pending: MapDelta[] = [];
  private fetching = false;
  private stopped = false;
  private again = false;
  private watermark = 0;
  private opened = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private repo: string;
  private get: () => Promise<MapSnapshot>;
  private receive: (s: MapSnapshot) => void;
  private error: (e: Error | null) => void;
  private skipped: (calls: number, messages: number) => void;
  private hiddenCalls = 0;
  private hiddenMessages = 0;
  private visibility = () => {
    if (!document.hidden && (this.hiddenCalls || this.hiddenMessages)) {
      this.skipped(this.hiddenCalls, this.hiddenMessages);
      this.hiddenCalls = 0;
      this.hiddenMessages = 0;
    }
  };

  constructor(
    repo: string,
    get: () => Promise<MapSnapshot>,
    receive: (s: MapSnapshot) => void,
    error: (e: Error | null) => void,
    skipped: (calls: number, messages: number) => void = () => {},
  ) {
    this.repo = repo;
    this.get = get;
    this.receive = receive;
    this.error = error;
    this.skipped = skipped;
  }

  start() {
    document.addEventListener("visibilitychange", this.visibility);
    this.source = new EventSource(`/api/stream?map=${encodeURIComponent(this.repo)}`);
    this.source.addEventListener("open", () => {
      const first = !this.opened;
      this.opened = true;
      if (!first) this.watermark = 0;
      if (!first || !this.fetching) void this.refresh();
    });
    this.source.addEventListener("error", () =>
      this.error(new Error("Map disconnected; reconnecting…")),
    );
    this.source.addEventListener("changed", (e) => {
      try {
        const { topic } = JSON.parse((e as MessageEvent).data);
        if (["agents", "boards", "config"].includes(topic)) void this.refresh();
      } catch {
        void this.refresh();
      }
    });
    this.source.addEventListener("map", (e) => {
      if (this.stopped) return;
      try {
        const delta = JSON.parse((e as MessageEvent).data) as MapDelta;
        if (!Number.isSafeInteger(delta.seq) || typeof delta.type !== "string")
          throw new Error("Invalid map event");
        if (delta.seq <= this.watermark) return;
        this.watermark = delta.seq;
        if (document.hidden) {
          if (delta.type === "call.start") this.hiddenCalls++;
          if (delta.type === "message") this.hiddenMessages++;
        }
        if (this.fetching || !this.snapshot) {
          this.pending.push(delta);
          return;
        }
        // The current collector returns seq: 0. Without a snapshot watermark an edit
        // may already be counted, so use its events as invalidations, never add churn twice.
        const next = this.snapshot.seq === 0 ? null : applyDelta(this.snapshot, delta, Date.now());
        if (next) {
          this.snapshot = next;
          this.receive(next);
        } else void this.refresh();
      } catch {
        void this.refresh();
      }
    });
    void this.refresh();
  }

  async refresh() {
    if (this.stopped) return;
    if (this.fetching) {
      this.again = true;
      return;
    }
    clearTimeout(this.retry);
    this.fetching = true;
    try {
      let snapshot: MapSnapshot = await this.get();
      if (this.stopped) return;
      for (const delta of this.pending) {
        const next: MapSnapshot | null =
          snapshot.seq === 0 ? null : applyDelta(snapshot, delta, Date.now());
        if (next) snapshot = next;
        else this.again = true;
      }
      this.pending = [];
      this.snapshot = snapshot;
      this.watermark = Math.max(this.watermark, snapshot.seq);
      this.receive(snapshot);
      this.error(null);
    } catch (e) {
      if (!this.stopped) {
        this.error(e instanceof Error ? e : new Error("Map unavailable"));
        this.retry = setTimeout(() => {
          void this.refresh();
        }, 5000);
      }
    } finally {
      this.fetching = false;
      if (this.again && !this.stopped) {
        this.again = false;
        clearTimeout(this.retry);
        this.retry = setTimeout(() => {
          void this.refresh();
        }, 0);
      }
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.source?.close();
    document.removeEventListener("visibilitychange", this.visibility);
  }
}
