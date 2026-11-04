import { execFile, spawn } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import type { BoardItem, MapSnapshot, PullRequestView } from "@mc/core";
import { GIT_MAX_BUFFER, GIT_TIMEOUT_MS, gitEnv } from "../files.ts";
import {
  MAP_COUPLING_CAP,
  MAP_COUPLING_PR_FILES_MAX,
  mapCouplingEligible,
} from "./history-rules.ts";

const exec = promisify(execFile);
type Tree = Pick<MapSnapshot, "tree" | "imports" | "hist">;
const cache = new Map<string, Tree>();
let pending: Promise<unknown> = Promise.resolve();

/**
 * Where the tree-keyed parts of the snapshot survive a restart: the tree and its imports (keyed by
 * the default-branch commit, which fixes its tree) and each merge's changed files (a merge commit
 * never changes). `exclusive` drops the other rows of that kind and scope.
 */
export interface MapPersist {
  get(kind: string, scope: string, key: string): string | null;
  put(kind: string, scope: string, key: string, value: string, exclusive: boolean): void;
}

/** The largest code file or manifest the Map opens for links; nothing else is ever opened. */
/** The stored-tree kind; renamed when a tile's weight changed meaning, so old rows are not read. */
export const MAP_TREE_KIND = "tree-weight";
export const MAP_BLOB_MAX_BYTES = 1024 * 1024;
/** A tile's weight is its bytes over this, so a file the Map never opens still gets a size. */
export const MAP_BYTES_PER_TILE_UNIT = 32;
/** The most blob bytes one tree read sends to git; links past it are left out, never the whole tree. */
export const MAP_READ_BUDGET_BYTES = 48 * 1024 * 1024;
/** A recorded run or a binary is a file to find, not area to give it: its tile weight stops here. */
export const MAP_EVIDENCE_TILE_UNITS = 1;
const MAP_PARSED_MAX = 20_000;
const MAP_CODE = /\.[cm]?[jt]sx?$/;
const MAP_EVIDENCE = /^docs\/evidence\//;
const MAP_BINARY =
  /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|mp4|mov|webm|zip|gz|tgz|tar|7z|woff2?|ttf|otf|log|patch|diff|sqlite|db)$/i;

/** A tile's weight: its bytes over a fixed unit, but evidence and binaries never outweigh code. */
export const mapTileSize = (bytes: number, path = ""): number => {
  if (bytes === 0) return 0;
  const units = Math.max(1, Math.ceil(bytes / MAP_BYTES_PER_TILE_UNIT));
  return MAP_EVIDENCE.test(path) || MAP_BINARY.test(path)
    ? Math.min(units, MAP_EVIDENCE_TILE_UNITS)
    : units;
};

/** What the links need from one blob, keyed by its sha so a new commit rereads only changed files. */
interface ParsedBlob {
  specs: { specifier: string; names: string[] }[];
  exported: string[];
  stars: string[];
  exports: [name: string, target: string][];
}
const parsedBlobs = new Map<string, ParsedBlob>();

function parseBlob(content: string): ParsedBlob {
  const specs: ParsedBlob["specs"] = [];
  for (const match of content.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g,
  )) {
    const clause =
      match.index === undefined
        ? ""
        : content.slice(Math.max(0, content.lastIndexOf("import", match.index)), match.index);
    const names = [...clause.matchAll(/\{([^}]+)\}/g)].flatMap((named) =>
      (named[1] as string)
        .split(",")
        .map(
          (part) =>
            part
              .trim()
              .replace(/^type\s+/, "")
              .split(/\s+as\s+/)[0] ?? "",
        )
        .filter(Boolean),
    );
    specs.push({ specifier: match[1] as string, names });
  }
  const exported = new Set<string>();
  for (const m of content.matchAll(
    /\bexport\s+(?:declare\s+)?(?:type\s+)?(?:const|let|var|class|function|interface|enum|namespace|type)\s+([\w$]+)/g,
  ))
    exported.add(m[1] as string);
  for (const m of content.matchAll(/\bexport\s*{([^}]*)}/g))
    for (const id of (m[1] as string).matchAll(/[\w$]+/g)) exported.add(id[0]);
  const stars = [...content.matchAll(/\bexport\s*\*\s+from\s*["']([^"']+)["']/g)].map(
    (m) => m[1] as string,
  );
  const exports: ParsedBlob["exports"] = [];
  if (content.trimStart().startsWith("{")) {
    try {
      const manifest = JSON.parse(content);
      if (
        typeof manifest.name === "string" &&
        manifest.exports &&
        typeof manifest.exports === "object"
      ) {
        for (const [name, target] of Object.entries(manifest.exports)) {
          if (typeof target === "string" && target.startsWith("./"))
            exports.push([
              name === "." ? manifest.name : `${manifest.name}/${name.replace(/^\.\//, "")}`,
              target,
            ]);
        }
      }
    } catch {
      // A malformed manifest does not hide the rest of the tree.
    }
  }
  return { specs, exported: [...exported], stars, exports };
}

/** The History lens's deliberately bounded view of merged work. */
export const MAP_HISTORY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** The commit `ref` names in the checkout: one cheap read, the key the cached tree is under. */
export async function mapHead(checkout: string, ref = "origin/HEAD"): Promise<string> {
  const env = { ...gitEnv(process.env), GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
  const { stdout } = await exec(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-C",
      checkout,
      "rev-parse",
      "--verify",
      `${ref}^{commit}`,
    ],
    { env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
  );
  return stdout.trim();
}

/** Serial tree reads leave one git slot for the conflict collector. Never fetch missing objects. */
export function mapTree(
  checkout: string,
  ref = "origin/HEAD",
  prs: readonly PullRequestView[] = [],
  board: readonly BoardItem[] = [],
  at = Date.now(),
  persist?: MapPersist,
  onBlobRead?: (shas: readonly string[]) => void,
): Promise<Tree> {
  const read = pending.then(async () => {
    const env = { ...gitEnv(process.env), GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
    const args = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", checkout];
    const git = async (...tail: string[]) =>
      (
        await exec("git", [...args, ...tail], {
          env,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
        })
      ).stdout;
    const commit = (await git("rev-parse", "--verify", `${ref}^{commit}`)).trim();
    const key = `${checkout}:${commit}`;
    const found = cache.get(key);
    if (found) return structuredClone(found);
    const readTree = async (): Promise<Pick<Tree, "tree" | "imports">> => {
      const treeSha = (await git("rev-parse", "--verify", `${commit}^{tree}`)).trim();
      const entries = (await git("ls-tree", "-rzl", treeSha)).split("\0").flatMap((row) => {
        const match = /^(?:100[0-7]{3}|120000) blob ([a-f0-9]+) +(\d+)\t([\s\S]+)$/.exec(row);
        return match
          ? [{ sha: match[1] as string, size: Number(match[2]), path: match[3] as string }]
          : [];
      });
      // The tree and its tile sizes come from file metadata alone; only code and manifests are opened.
      if (entries.length === 0) throw new Error("the checkout has no files at this commit");
      const tree = entries.map((e) => ({ path: e.path, lines: mapTileSize(e.size, e.path) }));
      const wanted = entries.filter(
        (e) =>
          e.size <= MAP_BLOB_MAX_BYTES &&
          (MAP_CODE.test(e.path) || posix.basename(e.path) === "package.json"),
      );
      const missing: string[] = [];
      const queued = new Set<string>();
      let budget = MAP_READ_BUDGET_BYTES;
      for (const e of wanted) {
        if (parsedBlobs.has(e.sha) || queued.has(e.sha) || e.size > budget) continue;
        budget -= e.size;
        queued.add(e.sha);
        missing.push(e.sha);
      }
      const local = new Map<string, ParsedBlob>();
      if (missing.length) {
        onBlobRead?.(missing);
        const blobs = await new Promise<Buffer>((resolve, reject) => {
          const child = spawn("git", [...args, "cat-file", "--batch"], {
            env,
            timeout: GIT_TIMEOUT_MS,
          });
          const chunks: Buffer[] = [];
          child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
          child.stderr.resume();
          child.on("error", reject);
          child.stdin.on("error", reject);
          child.on("close", (code) =>
            code === 0
              ? resolve(Buffer.concat(chunks))
              : reject(new Error("git could not read the files")),
          );
          child.stdin.end(`${missing.join("\n")}\n`);
        });
        let offset = 0;
        for (const sha of missing) {
          const end = blobs.indexOf(10, offset);
          if (end < 0) throw new Error("invalid map blob");
          const header = blobs.subarray(offset, end).toString().split(" ");
          if (header[1] === "missing") {
            offset = end + 1;
            continue;
          }
          const size = Number(header[2]);
          if (!Number.isSafeInteger(size)) throw new Error("invalid map blob");
          const bytes = blobs.subarray(end + 1, end + 1 + size);
          offset = end + size + 2;
          const blob = parseBlob(bytes.includes(0) ? "" : bytes.toString("utf8"));
          local.set(sha, blob);
          parsedBlobs.set(sha, blob);
          if (parsedBlobs.size > MAP_PARSED_MAX)
            parsedBlobs.delete(parsedBlobs.keys().next().value as string);
        }
      }
      const parsed = (sha: string): ParsedBlob =>
        local.get(sha) ??
        parsedBlobs.get(sha) ?? { specs: [], exported: [], stars: [], exports: [] };
      const sources = new Map<string, ParsedBlob>();
      const workspace = new Map<string, string>();
      for (const e of wanted) {
        const blob = parsed(e.sha);
        if (MAP_CODE.test(e.path)) sources.set(e.path, blob);
        if (posix.basename(e.path) === "package.json")
          for (const [name, target] of blob.exports)
            workspace.set(name, posix.join(posix.dirname(e.path), target));
      }
      const paths = new Set(tree.map((f) => f.path));
      const resolve = (base: string): string | null => {
        const candidates = [
          base,
          ...[".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"].map((ext) => base + ext),
          base.replace(/\.js$/, ".ts"),
        ];
        return candidates.find((p) => paths.has(p)) ?? null;
      };
      const exportedFrom = (
        path: string,
        name: string,
        seen = new Set<string>(),
      ): string | null => {
        if (seen.has(path)) return null;
        seen.add(path);
        const blob = sources.get(path);
        if (!blob) return null;
        if (blob.exported.includes(name)) return path;
        for (const specifier of blob.stars) {
          const next = specifier.startsWith(".")
            ? resolve(posix.normalize(posix.join(posix.dirname(path), specifier)))
            : resolve(workspace.get(specifier) ?? "");
          if (!next) continue;
          const found = exportedFrom(next, name, seen);
          if (found) return found;
        }
        return null;
      };
      const imports: Tree["imports"] = [];
      for (const [from, blob] of sources) {
        const targets = new Set<string>();
        for (const { specifier, names } of blob.specs) {
          const base = specifier.startsWith(".")
            ? posix.normalize(posix.join(posix.dirname(from), specifier))
            : workspace.get(specifier);
          if (!base) continue;
          const to = resolve(base);
          if (!to) continue;
          if (names.length === 0) targets.add(to);
          else for (const name of names) targets.add(exportedFrom(to, name) ?? to);
        }
        for (const to of targets) imports.push({ from, to });
      }
      return { tree, imports };
    };
    let stored: Pick<Tree, "tree" | "imports"> | null = null;
    try {
      const raw = persist?.get(MAP_TREE_KIND, checkout, commit);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        Array.isArray((parsed as Tree).tree) &&
        Array.isArray((parsed as Tree).imports)
      )
        stored = parsed as Pick<Tree, "tree" | "imports">;
    } catch {
      // an unreadable stored row is recomputed
    }
    const { tree, imports } = stored ?? (await readTree());
    if (!stored) {
      try {
        persist?.put(MAP_TREE_KIND, checkout, commit, JSON.stringify({ tree, imports }), true);
      } catch {
        // the store is a cache: a failed write only costs the next start
      }
    }
    const since = at - MAP_HISTORY_WINDOW_MS;
    const pathIndex = new Map(tree.map((file, index) => [file.path, index]));
    const tickets = new Map(board.map((item) => [`${item.repoId}#${item.issueNumber}`, item]));
    const byMerge = new Map(
      prs
        .filter((pr) => pr.state === "merged" && pr.mergeCommitSha)
        .map((pr) => [pr.mergeCommitSha as string, pr]),
    );
    const changes: {
      pr: PullRequestView;
      files: string[];
      changedFileCount: number;
      bug: boolean;
    }[] = [];
    const mergeShas = (await git("log", "--merges", "--first-parent", "--format=%H", commit))
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const mergeSha of mergeShas) {
      const pr = byMerge.get(mergeSha);
      if (!pr || pr.mergedAt === null || pr.mergedAt < since) continue;
      let changedPaths: string[] | null = null;
      try {
        const raw = persist?.get("merge", "", mergeSha);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string"))
          changedPaths = parsed;
      } catch {
        // an unreadable stored row is recomputed
      }
      if (!changedPaths) {
        changedPaths = (
          await git("diff-tree", "--no-commit-id", "--name-only", "-r", `${mergeSha}^1`, mergeSha)
        )
          .split("\n")
          .filter(Boolean);
        try {
          persist?.put("merge", "", mergeSha, JSON.stringify(changedPaths), false);
        } catch {
          // the store is a cache: a failed write only costs the next start
        }
      }
      const files = changedPaths.filter((path) => pathIndex.has(path));
      const bug =
        pr.branch.startsWith("fix/") ||
        tickets.get(pr.ticket ?? "")?.labels.includes("bug") === true;
      changes.push({ pr, files, changedFileCount: new Set(changedPaths).size, bug });
    }
    const hist: Tree["hist"] = {
      since,
      prCount: changes.length,
      fixCount: changes.filter((x) => x.bug).length,
      files: {},
      coupling: [],
    };
    const filePrs = new Map<string, { number: number; mergedAt: number; bug: boolean }[]>();
    const couplingFiles = new Map<string, number>();
    const pairs = new Map<string, number>();
    for (const change of changes) {
      for (const file of change.files) {
        const rows = filePrs.get(file) ?? [];
        rows.push({
          number: change.pr.number,
          mergedAt: change.pr.mergedAt as number,
          bug: change.bug,
        });
        filePrs.set(file, rows);
      }
      if (change.changedFileCount > MAP_COUPLING_PR_FILES_MAX) continue;
      const unique = [...new Set(change.files)].sort();
      for (const file of unique) couplingFiles.set(file, (couplingFiles.get(file) ?? 0) + 1);
      for (let i = 0; i < unique.length; i++)
        for (let j = i + 1; j < unique.length; j++) {
          const key = `${unique[i]}\0${unique[j]}`;
          pairs.set(key, (pairs.get(key) ?? 0) + 1);
        }
    }
    for (const [path, rows] of filePrs) {
      const index = pathIndex.get(path);
      if (index === undefined) continue;
      rows.sort((a, b) => b.mergedAt - a.mergedAt);
      hist.files[String(index)] = [
        rows.length,
        rows.filter((row) => row.bug).length,
        rows[0]?.mergedAt ?? 0,
        rows.map((row) => row.number).slice(0, 12),
      ];
    }
    hist.coupling = [...pairs]
      .flatMap(([key, count]) => {
        const [left, right] = key.split("\0");
        const leftIndex = pathIndex.get(left);
        const rightIndex = pathIndex.get(right);
        const smaller = Math.min(couplingFiles.get(left) ?? 0, couplingFiles.get(right) ?? 0);
        return leftIndex === undefined ||
          rightIndex === undefined ||
          !mapCouplingEligible(count, smaller)
          ? []
          : [[leftIndex, rightIndex, count, count / smaller] as [number, number, number, number]];
      })
      .sort((a, b) => b[2] - a[2])
      .slice(0, MAP_COUPLING_CAP);
    const value = { tree, imports, hist };
    cache.set(key, value);
    if (cache.size > 8) cache.delete(cache.keys().next().value as string);
    return structuredClone(value);
  });
  pending = read.catch(() => {});
  return read;
}
