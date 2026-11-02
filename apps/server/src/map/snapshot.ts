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
      const entries = (await git("ls-tree", "-rz", treeSha)).split("\0").flatMap((row) => {
        const match = /^(?:100[0-7]{3}|120000) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
        return match ? [{ sha: match[1] as string, path: match[2] as string }] : [];
      });
      const blobs = await new Promise<Buffer>((resolve, reject) => {
        const child = spawn("git", [...args, "cat-file", "--batch"], {
          env,
          timeout: GIT_TIMEOUT_MS,
        });
        const chunks: Buffer[] = [];
        let size = 0;
        child.stdout.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024 * 1024) child.kill();
          else chunks.push(chunk);
        });
        child.stderr.resume();
        child.on("error", reject);
        child.stdin.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("map tree unavailable")),
        );
        child.stdin.end(`${entries.map((e) => e.sha).join("\n")}\n`);
      });
      let offset = 0;
      const sources = new Map<string, string>();
      const workspace = new Map<string, string>();
      const tree = entries.map((entry) => {
        const end = blobs.indexOf(10, offset);
        const size = Number(blobs.subarray(offset, end).toString().split(" ")[2]);
        if (end < 0 || !Number.isSafeInteger(size)) throw new Error("invalid map blob");
        const bytes = blobs.subarray(end + 1, end + 1 + size);
        offset = end + size + 2;
        const content = bytes.includes(0) ? "" : bytes.toString("utf8");
        if (/\.[cm]?[jt]sx?$/.test(entry.path)) sources.set(entry.path, content);
        if (posix.basename(entry.path) === "package.json") {
          try {
            const manifest = JSON.parse(content);
            if (
              typeof manifest.name === "string" &&
              manifest.exports &&
              typeof manifest.exports === "object"
            ) {
              for (const [name, target] of Object.entries(manifest.exports)) {
                if (typeof target === "string" && target.startsWith("./")) {
                  workspace.set(
                    name === "." ? manifest.name : `${manifest.name}/${name.replace(/^\.\//, "")}`,
                    posix.join(posix.dirname(entry.path), target),
                  );
                }
              }
            }
          } catch {
            // A malformed manifest does not hide the rest of the tree.
          }
        }
        return {
          path: entry.path,
          lines: content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0),
        };
      });
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
        const content = sources.get(path);
        if (!content) return null;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (
          new RegExp(
            `\\bexport\\s+(?:declare\\s+)?(?:type\\s+)?(?:const|let|var|class|function|interface|enum|namespace|type)\\s+${escaped}\\b`,
          ).test(content) ||
          new RegExp(`\\bexport\\s*{[^}]*\\b${escaped}(?:\\s+as\\s+\\w+)?[^}]*}`).test(content)
        )
          return path;
        for (const star of content.matchAll(/\bexport\s*\*\s+from\s*["']([^"']+)["']/g)) {
          const specifier = star[1] as string;
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
      for (const [from, content] of sources) {
        const targets = new Set<string>();
        for (const match of content.matchAll(
          /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g,
        )) {
          const specifier = match[1] as string;
          const base = specifier.startsWith(".")
            ? posix.normalize(posix.join(posix.dirname(from), specifier))
            : workspace.get(specifier);
          if (!base) continue;
          const to = resolve(base);
          if (!to) continue;
          const clause =
            match.index === undefined
              ? ""
              : content.slice(Math.max(0, content.lastIndexOf("import", match.index)), match.index);
          const names = [...clause.matchAll(/\{([^}]+)\}/g)].flatMap((named) =>
            (named[1] as string).split(",").map(
              (part) =>
                part
                  .trim()
                  .replace(/^type\s+/, "")
                  .split(/\s+as\s+/)[0] ?? "",
            ),
          );
          if (names.length === 0) targets.add(to);
          else for (const name of names) targets.add(exportedFrom(to, name) ?? to);
        }
        for (const to of targets) imports.push({ from, to });
      }
      return { tree, imports };
    };
    let stored: Pick<Tree, "tree" | "imports"> | null = null;
    try {
      const raw = persist?.get("tree", checkout, commit);
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
        persist?.put("tree", checkout, commit, JSON.stringify({ tree, imports }), true);
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
