import { execFile, spawn } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import type { MapSnapshot } from "@mc/core";
import { GIT_MAX_BUFFER, GIT_TIMEOUT_MS, gitEnv } from "../files.ts";

const exec = promisify(execFile);
type Tree = Pick<MapSnapshot, "tree" | "imports">;
const cache = new Map<string, Tree>();
let pending: Promise<unknown> = Promise.resolve();

/** Serial tree reads leave one git slot for the conflict collector. Never fetch missing objects. */
export function mapTree(checkout: string, ref = "origin/HEAD"): Promise<Tree> {
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
    const sha = (await git("rev-parse", "--verify", `${ref}^{tree}`)).trim();
    const key = `${checkout}:${sha}`;
    const found = cache.get(key);
    if (found) return structuredClone(found);
    const entries = (await git("ls-tree", "-rz", sha)).split("\0").flatMap((row) => {
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
        const candidates = [
          base,
          ...[".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"].map((ext) => base + ext),
          base.replace(/\.js$/, ".ts"),
        ];
        const to = candidates.find((p) => paths.has(p));
        if (to) targets.add(to);
      }
      for (const to of targets) imports.push({ from, to });
    }
    const value = { tree, imports };
    cache.set(key, value);
    if (cache.size > 8) cache.delete(cache.keys().next().value as string);
    return structuredClone(value);
  });
  pending = read.catch(() => {});
  return read;
}
