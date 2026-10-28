import type { MapSnapshot } from "@mc/core";
import { forceLayout } from "./layout.ts";
import type { MapNode } from "./model.ts";

type Response = { id: number; nodes: MapNode[] };

/** One long-lived worker keeps force layout and structured-clone work off the interaction thread. */
class MapLayoutWorker {
  private worker: Worker | null = null;
  private nextId = 0;
  private pending = new Map<number, (nodes: MapNode[]) => void>();

  layout(tree: MapSnapshot["tree"], imports: MapSnapshot["imports"], previous?: MapNode[]) {
    // Tests and obsolete browsers have no Worker. Production-capable browsers always use the
    // worker path above; keeping this fallback makes the map degrade rather than disappear.
    if (typeof Worker === "undefined")
      return Promise.resolve().then(() =>
        forceLayout(
          tree,
          imports,
          undefined,
          previous ? new Map(previous.map((node) => [node.path, node.position])) : undefined,
        ),
      );
    const worker = this.getWorker();
    return new Promise<MapNode[]>((resolve) => {
      const id = ++this.nextId;
      this.pending.set(id, resolve);
      worker.postMessage({ id, tree, imports, previous });
    });
  }

  private getWorker() {
    if (!this.worker) {
      this.worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = ({ data }: MessageEvent<Response>) => {
        const resolve = this.pending.get(data.id);
        if (resolve) {
          this.pending.delete(data.id);
          resolve(data.nodes);
        }
      };
    }
    return this.worker;
  }
}

export const mapLayoutWorker = new MapLayoutWorker();
