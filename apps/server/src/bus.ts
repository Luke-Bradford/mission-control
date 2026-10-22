import type { Topic } from "@mc/core";

export type { Topic };

/** In-process change notifications from collectors and actions to SSE streams. */
export class ChangeBus {
  private readonly listeners = new Set<(topic: Topic) => void>();

  subscribe(fn: (topic: Topic) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(topic: Topic): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(topic);
      } catch {
        // one broken subscriber must not stop the others
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
