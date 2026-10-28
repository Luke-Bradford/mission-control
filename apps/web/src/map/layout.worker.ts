import { forceLayout } from "./layout.ts";
import type { MapNode } from "./model.ts";

type Request = {
  id: number;
  tree: { path: string; lines: number }[];
  imports: { from: string; to: string }[];
  previous?: MapNode[];
};

const layouts = new Map<string, MapNode[]>();
const keyFor = (tree: Request["tree"], imports: Request["imports"]) =>
  `${tree
    .map((file) => file.path)
    .sort()
    .join("\n")}\0${imports.map((edge) => `${edge.from}>${edge.to}`).join("\n")}`;

self.onmessage = ({ data }: MessageEvent<Request>) => {
  const key = keyFor(data.tree, data.imports);
  const previous = data.previous ?? layouts.get(key);
  const nodes = forceLayout(
    data.tree,
    data.imports,
    undefined,
    previous ? new Map(previous.map((node) => [node.path, node.position])) : undefined,
  );
  layouts.set(key, nodes);
  postMessage({ id: data.id, nodes });
};
