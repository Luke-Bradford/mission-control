/**
 * A design preview: a branch's built web app (apps/web/dist), kept by the hub and served on its own
 * loopback port, so the operator sees the real app, with Demo data, as it would ship.
 *
 * The seat builds in its own sandbox; the hub only copies the finished files, never runs the
 * branch's code. The listener has no token, no proxy and no route into the hub: its origin differs
 * from the hub's, and its CSP lets the page talk to itself only.
 */
import { constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import type { DesignPreviewView } from "@mc/core";
import Fastify, { type FastifyInstance } from "fastify";
import { DESIGN_PREVIEW_PORT } from "./design-preview-port.ts";
import { webHandler } from "./web.ts";

export { DESIGN_PREVIEW_PORT };
export const DESIGN_PREVIEW_IDLE_MS = 60 * 60_000;
export const DESIGN_PREVIEW_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const DESIGN_PREVIEW_MAX_STORED = 5;
export const DESIGN_PREVIEW_MAX_BYTES = 64 * 1024 * 1024;
export const DESIGN_PREVIEW_MAX_FILES = 2000;
/** The sweep runs this often; `open` and `list` apply the same rules first. */
export const DESIGN_PREVIEW_SWEEP_MS = 60_000;

/** The only file types a preview serves; no secret lives in any of them. */
const SERVED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".svg",
  ".png",
  ".ico",
  ".woff",
  ".woff2",
  ".webmanifest",
]);
const NAME = /^[A-Za-z0-9._-]+$/;
const BOOT_PATH = "/mc-preview-boot";
const BOOT_TAG = `<script src="${BOOT_PATH}"></script>`;

/** Runs before the app's module: the app boots in Demo, and knows it is a preview. */
export const PREVIEW_BOOT_SCRIPT =
  'try{sessionStorage.setItem("mc-demo","true");document.documentElement.dataset.mcPreview="1"}catch{}';

export const NO_PREVIEW_TEXT = "No preview is running. Open one from Needs you.";
export const PREVIEW_HAS_NO_HUB = "A preview has no hub. It shows Demo data only.";

/** The CSP of every preview answer: the page may load and talk to its own origin and no other. */
export function previewCsp(hubPort: number): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors http://127.0.0.1:${hubPort} http://localhost:${hubPort}`,
  ].join("; ");
}

/** A publish the hub will not accept; the message is the tool's answer. */
export class PreviewRefused extends Error {}

const notServed = (path: string) =>
  new PreviewRefused(
    `Not published: ${path} in the build is not a file type the preview serves. Remove it and publish again.`,
  );
const NO_BUILD = new PreviewRefused(
  "Not published: your worktree has no web build. Run pnpm -s build, then publish again.",
);
const TOO_BIG = new PreviewRefused("Not published: the build is over 64 MB or 2,000 files.");

interface Manifest {
  ticket: number;
  branch: string;
  sha: string;
  publishedAt: number;
}

export interface DesignPreviewsDeps {
  root: string;
  port: number;
  hubPort: number;
  prOf(branch: string): { number: number; state: "open" | "closed" | "merged" } | null;
  now?: () => number;
  log?: (line: string) => void;
}

export class DesignPreviews {
  private readonly stored = new Map<number, Manifest>();
  private running: { ticket: number; usedAt: number } | null = null;
  private fastify: FastifyInstance | null = null;
  private readonly handlers = new Map<string, ReturnType<typeof webHandler>>();
  private readonly now: () => number;
  private readonly csp: string;

  private readonly deps: DesignPreviewsDeps;

  constructor(deps: DesignPreviewsDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.csp = previewCsp(deps.hubPort);
    mkdirSync(deps.root, { recursive: true, mode: 0o700 });
    this.load();
  }

  private siteDir(ticket: number): string {
    return join(this.deps.root, String(ticket), "site");
  }

  /** A restart keeps the builds on disk, with nothing running. */
  private load(): void {
    for (const name of readdirSync(this.deps.root)) {
      if (!/^[1-9]\d*$/.test(name)) {
        // a publish that did not finish
        if (name.startsWith("."))
          rmSync(join(this.deps.root, name), { recursive: true, force: true });
        continue;
      }
      try {
        const m = JSON.parse(
          readFileSync(join(this.deps.root, name, "manifest.json"), "utf8"),
        ) as Manifest;
        if (m.ticket === Number(name) && existsSync(this.siteDir(m.ticket)))
          this.stored.set(m.ticket, m);
      } catch {
        rmSync(join(this.deps.root, name), { recursive: true, force: true });
      }
    }
  }

  private view(m: Manifest): DesignPreviewView {
    return {
      ticket: m.ticket,
      branch: m.branch,
      sha: m.sha,
      publishedAt: m.publishedAt,
      pr: this.deps.prOf(m.branch)?.number ?? null,
      running: this.running?.ticket === m.ticket,
      url: `http://127.0.0.1:${this.deps.port}/`,
    };
  }

  /** Forgets the build now and returns the file deletion, so a list never shows what is gone. */
  private drop(ticket: number): Promise<void> {
    this.stored.delete(ticket);
    this.handlers.clear();
    if (this.running?.ticket === ticket) this.running = null;
    return rm(join(this.deps.root, String(ticket)), { recursive: true, force: true });
  }

  /** The slot's idle rule: a clock read and nothing else, so every request can apply it. */
  private expireIdle(): void {
    if (this.running !== null && this.now() - this.running.usedAt > DESIGN_PREVIEW_IDLE_MS) {
      this.running = null;
    }
  }

  /** The rules `sweep` runs, applied before every list, open and request too. */
  private apply(): Promise<void>[] {
    const now = this.now();
    const deletions: Promise<void>[] = [];
    for (const m of [...this.stored.values()]) {
      const pr = this.deps.prOf(m.branch);
      if (
        pr?.state === "closed" ||
        pr?.state === "merged" ||
        now - m.publishedAt > DESIGN_PREVIEW_MAX_AGE_MS
      ) {
        deletions.push(this.drop(m.ticket));
      }
    }
    this.expireIdle();
    return deletions;
  }

  async sweep(): Promise<void> {
    await Promise.all(this.apply());
  }

  list(): DesignPreviewView[] {
    for (const done of this.apply()) {
      done.catch((e: unknown) => this.deps.log?.(`design previews: delete failed: ${String(e)}`));
    }
    return [...this.stored.values()].sort((a, b) => a.ticket - b.ticket).map((m) => this.view(m));
  }

  async open(ticket: number): Promise<DesignPreviewView | null> {
    await this.sweep();
    const m = this.stored.get(ticket);
    if (m === undefined) return null;
    this.running = { ticket, usedAt: this.now() };
    return this.view(m);
  }

  async publish(input: {
    ticket: number;
    branch: string;
    sha: string;
    worktree: string;
  }): Promise<DesignPreviewView> {
    await this.sweep();
    const { ticket } = input;
    const root = this.deps.root;
    const tmp = join(root, `.tmp-${ticket}-${process.pid}-${this.now()}`);
    const manifest: Manifest = {
      ticket,
      branch: input.branch,
      sha: input.sha,
      publishedAt: this.now(),
    };
    try {
      await mkdir(join(tmp, "site"), { recursive: true, mode: 0o700 });
      await copyBuild(input.worktree, join(tmp, "site"));
      await writeFile(join(tmp, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
      const final = join(root, String(ticket));
      const old = `${tmp}-old`;
      const had = this.stored.has(ticket) || existsSync(final);
      if (had) await rename(final, old);
      await rename(tmp, final);
      if (had) await rm(old, { recursive: true, force: true });
    } catch (e) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    this.stored.set(ticket, manifest);
    this.handlers.delete(String(ticket));
    if (this.running === null) this.running = { ticket, usedAt: this.now() };
    // a sixth stored build deletes the oldest one that is not running
    while (this.stored.size > DESIGN_PREVIEW_MAX_STORED) {
      const oldest = [...this.stored.values()]
        .filter((m) => m.ticket !== ticket && m.ticket !== this.running?.ticket)
        .sort((a, b) => a.publishedAt - b.publishedAt)[0];
      if (oldest === undefined) break;
      await this.drop(oldest.ticket);
    }
    return this.view(manifest);
  }

  /** The listener, built once. Tests call `inject` on it; `listen` binds it. */
  app(): FastifyInstance {
    if (this.fastify !== null) return this.fastify;
    const app = Fastify({ logger: false });
    const hosts = new Set([`127.0.0.1:${this.deps.port}`, `localhost:${this.deps.port}`]);
    app.addHook("onRequest", async (req, reply) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return reply.code(405).header("allow", "GET, HEAD").send("method not allowed");
      }
      if (!hosts.has(req.headers.host ?? "")) return reply.code(421).send("misdirected request");
      // All previews share this origin: a service worker from one ticket's build would keep
      // answering for the next, and for a closed PR's. No build may register one.
      if (req.headers["service-worker"] !== undefined) return reply.code(404).send("not found");
    });
    app.addHook("onSend", async (_req, reply, payload) => {
      reply.header("content-security-policy", this.csp);
      reply.header("x-content-type-options", "nosniff");
      reply.header("referrer-policy", "no-referrer");
      reply.header("cross-origin-opener-policy", "same-origin");
      // the origin is shared by every ticket's build, so the browser keeps nothing as immutable
      reply.header("cache-control", "no-cache");
      return payload;
    });
    const noHub = async (_req: unknown, reply: import("fastify").FastifyReply) =>
      reply.code(404).send({ error: PREVIEW_HAS_NO_HUB });
    app.all("/api", noHub);
    app.all("/api/*", noHub);
    app.get(BOOT_PATH, async (_req, reply) =>
      reply
        .type("text/javascript; charset=utf-8")
        .header("cache-control", "no-cache")
        .send(PREVIEW_BOOT_SCRIPT),
    );
    app.setNotFoundHandler(async (req, reply) => {
      // no PR lookup per file: the 60 s sweep and open() apply those rules
      this.expireIdle();
      const slot = this.running;
      const m = slot === null ? undefined : this.stored.get(slot.ticket);
      if (slot === null || m === undefined) {
        return reply.code(404).type("text/plain; charset=utf-8").send(NO_PREVIEW_TEXT);
      }
      slot.usedAt = this.now();
      const key = `${m.ticket}:${m.publishedAt}`;
      let handler = this.handlers.get(key);
      if (handler === undefined) {
        handler = webHandler(this.siteDir(m.ticket), this.csp);
        this.handlers.set(key, handler);
      }
      return handler(req, reply);
    });
    this.fastify = app;
    return app;
  }

  async listen(): Promise<void> {
    await this.app().listen({ host: "127.0.0.1", port: this.deps.port });
  }

  async close(): Promise<void> {
    await this.fastify?.close();
    this.fastify = null;
  }
}

interface FileEntry {
  rel: string;
  size: number;
}

/** Every file under `dir`, refusing the whole build on anything it must not serve. */
async function walk(dir: string, rel: string, out: FileEntry[]): Promise<void> {
  for (const name of await readdir(dir)) {
    const path = rel === "" ? name : `${rel}/${name}`;
    if (!NAME.test(name)) throw notServed(path);
    const full = join(dir, name);
    const st = await lstat(full);
    if (st.isSymbolicLink()) throw notServed(path);
    if (st.isDirectory()) {
      await walk(full, path, out);
      continue;
    }
    if (!st.isFile() || !SERVED_EXTENSIONS.has(extname(name).toLowerCase())) throw notServed(path);
    out.push({ rel: path, size: st.size });
    if (out.length > DESIGN_PREVIEW_MAX_FILES) throw TOO_BIG;
  }
}

/** Copies the worktree's `apps/web/dist` into `dest`, adding the boot script to index.html. */
async function copyBuild(worktree: string, dest: string): Promise<void> {
  let top: string;
  let dist: string;
  try {
    top = await realpath(worktree);
    dist = await realpath(join(worktree, "apps", "web", "dist"));
  } catch {
    throw NO_BUILD;
  }
  // a symlinked dist or apps/web must not lead out of the worktree
  if (!dist.startsWith(top + sep)) throw NO_BUILD;
  const files: FileEntry[] = [];
  await walk(dist, "", files);
  if (!files.some((f) => f.rel === "index.html")) throw NO_BUILD;
  let bytes = 0;
  for (const f of files) {
    bytes += f.size;
    if (bytes > DESIGN_PREVIEW_MAX_BYTES) throw TOO_BIG;
  }
  bytes = 0;
  for (const f of files) {
    const from = join(dist, f.rel);
    // O_NOFOLLOW stops a file swapped for a link after the walk; the realpath stops a swapped folder
    const handle = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
      throw notServed(f.rel);
    });
    let body: Buffer;
    try {
      if (!(await handle.stat()).isFile()) throw notServed(f.rel);
      const real = await realpath(from);
      if (!real.startsWith(dist + sep)) throw notServed(f.rel);
      body = await handle.readFile();
    } finally {
      await handle.close();
    }
    bytes += body.length;
    if (bytes > DESIGN_PREVIEW_MAX_BYTES) throw TOO_BIG;
    if (f.rel === "index.html") {
      const html = body.toString("utf8");
      const head = /<head(\s[^>]*)?>/i.exec(html);
      if (head === null)
        throw new PreviewRefused("Not published: index.html in the build has no <head>.");
      const at = head.index + head[0].length;
      body = Buffer.from(`${html.slice(0, at)}${BOOT_TAG}${html.slice(at)}`);
    }
    const to = join(dest, f.rel);
    await mkdir(join(to, ".."), { recursive: true, mode: 0o700 });
    await writeFile(to, body, { mode: 0o600 });
  }
}
