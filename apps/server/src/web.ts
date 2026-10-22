/**
 * Serves the built web app (apps/web/dist) for GET/HEAD requests that no route matched: files by
 * path, and index.html for extension-less paths (SPA routes such as /needs-you).
 * Assets are static; all data is under /api, which only a loopback Host may reach.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

/** The app is scripts, styles and fonts from this origin only; it talks to this origin only. */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Vite emits content-hashed file names under /assets/, so they can be cached for good. */
const HASHED_PREFIX = "/assets/";

type Resolved = { kind: "file"; path: string } | { kind: "bad" };

/** Map a request path to a file inside `root`, or refuse it. Never resolves outside `root`. */
export function resolveWebPath(root: string, urlPath: string): Resolved {
  let path: string;
  try {
    path = decodeURIComponent(urlPath);
  } catch {
    return { kind: "bad" };
  }
  if (!path.startsWith("/") || path.includes("\0") || path.includes("\\")) return { kind: "bad" };
  if (path.split("/").some((seg) => seg === "..")) return { kind: "bad" };
  const file = resolve(root, `.${path}`);
  if (file !== root && !file.startsWith(root + sep)) return { kind: "bad" };
  return { kind: "file", path: file };
}

async function readInside(root: string, file: string): Promise<Buffer | null> {
  try {
    const real = await realpath(file);
    // A symlink inside dist must not lead outside it either.
    if (!real.startsWith(root + sep)) return null;
    if (!(await stat(real)).isFile()) return null;
    return await readFile(real);
  } catch {
    return null;
  }
}

export function webHandler(webRoot: string) {
  const rootPromise = realpath(resolve(webRoot)).catch(() => resolve(webRoot));

  return async (req: FastifyRequest, reply: FastifyReply) => {
    const root = await rootPromise;
    const urlPath = req.url.split("?")[0] ?? "/";
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");

    const target = resolveWebPath(root, urlPath);
    if (target.kind === "bad") {
      return reply.code(400).type("text/plain; charset=utf-8").send("bad path");
    }
    // Assets and top-level files (/icon.svg) are files: served or 404. Anything else is an SPA
    // route, even with a dot in it (/boards/some.repo), and gets index.html.
    const ext = extname(target.path);
    const topLevel = urlPath.lastIndexOf("/") === 0;
    const isFile =
      urlPath.startsWith(HASHED_PREFIX) ||
      urlPath === HASHED_PREFIX.slice(0, -1) ||
      (topLevel && ext !== "");
    const file = isFile ? target.path : resolve(root, "index.html");
    const body = await readInside(root, file);
    if (!body) {
      const text = isFile ? "not found" : "web app not built: run pnpm build";
      return reply.code(404).type("text/plain; charset=utf-8").send(text);
    }
    const type = TYPES[isFile ? ext.toLowerCase() : ".html"] ?? "application/octet-stream";
    reply.type(type);
    if (type.startsWith("text/html")) reply.header("content-security-policy", WEB_CSP);
    reply.header(
      "cache-control",
      isFile && urlPath.startsWith(HASHED_PREFIX)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
    return reply.send(body);
  };
}
