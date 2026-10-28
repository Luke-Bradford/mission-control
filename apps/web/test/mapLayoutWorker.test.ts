import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("sends a 10,000-file tree to the layout worker and retains one response node per file", async () => {
  let worker:
    | {
        onmessage: ((event: MessageEvent) => void) | null;
        postMessage: ReturnType<typeof vi.fn>;
      }
    | undefined;
  vi.stubGlobal(
    "Worker",
    class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage = vi.fn();
      constructor() {
        worker = this;
      }
    },
  );
  const { mapLayoutWorker } = await import("../src/map/layoutClient.ts");
  const tree = Array.from({ length: 10_000 }, (_, i) => ({ path: `src/f${i}.ts`, lines: 1 }));
  const layout = mapLayoutWorker.layout(tree, []);
  expect(worker?.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ tree, imports: [], previous: undefined }),
  );
  const nodes = tree.map((file, i) => ({
    path: file.path,
    parent: "src",
    area: "src",
    position: [i, 0, 0] as [number, number, number],
    files: [file.path],
    count: 1,
  }));
  worker?.onmessage?.({ data: { id: 1, nodes } } as MessageEvent);
  await expect(layout).resolves.toEqual(nodes);
});
