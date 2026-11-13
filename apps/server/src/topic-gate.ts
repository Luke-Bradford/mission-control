import { createHash } from "node:crypto";
import type { HealthRow } from "@mc/core";
import type { Topic } from "./bus.ts";

/** Builds what a topic's page would show; the gate compares it with the last one it saw. */
export type TopicContent = Partial<Record<Topic, () => unknown>>;

/**
 * What a topic's content is built from, as one string. While it is unchanged since the last check
 * the content is too, so the gate answers "unchanged" without building it.
 */
export type TopicBasis = Partial<Record<Topic, () => string>>;

/** Setup's "last OK" moves in steps of this size, so a quiet hub sends few health events. */
export const HEALTH_FRESHNESS_MS = 10 * 60_000;

/** Remembers a hash of each topic's content, so a topic is sent only when it changed. */
export class TopicGate {
  private readonly seen = new Map<Topic, string>();

  private readonly bases = new Map<Topic, string>();

  private readonly content: TopicContent;

  private readonly basis: TopicBasis;

  constructor(content: TopicContent, basis: TopicBasis = {}) {
    this.content = content;
    this.basis = basis;
  }

  /** Forgets every hash: the next check of each topic passes. */
  reset(): void {
    this.seen.clear();
    this.bases.clear();
  }

  /** True if the topic has no content function, it threw, or its content differs from the last seen. */
  changed(topic: Topic): boolean {
    const build = this.content[topic];
    if (build === undefined) return true;
    let basis: string | undefined;
    try {
      basis = this.basis[topic]?.();
    } catch {
      basis = undefined;
    }
    if (basis !== undefined && this.seen.has(topic) && this.bases.get(topic) === basis)
      return false;
    let hash: string;
    try {
      hash = createHash("sha256")
        .update(JSON.stringify(build()) ?? "")
        .digest("hex");
    } catch {
      this.seen.delete(topic);
      this.bases.delete(topic);
      return true;
    }
    if (basis !== undefined) this.bases.set(topic, basis);
    if (this.seen.get(topic) === hash) return false;
    this.seen.set(topic, hash);
    return true;
  }
}

/** The part of the collector rows a page shows: the recorded time is dropped, lastOkAt is stepped. */
export function healthContent(rows: HealthRow[]): unknown {
  return rows.map((r) => [
    r.collector,
    r.ok,
    r.error,
    r.failingSince ?? null,
    r.lastOkAt === null ? null : Math.floor(r.lastOkAt / HEALTH_FRESHNESS_MS),
  ]);
}
