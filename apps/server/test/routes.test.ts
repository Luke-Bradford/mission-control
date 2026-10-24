import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIONS, RESOURCES } from "../../web/src/data.ts";
import * as apiModule from "../src/api.ts";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const ROOT = join(import.meta.dirname, "../../..");
const API_SRC = join(ROOT, "apps/server/src/api.ts");
const WEB_DATA = join(ROOT, "apps/web/src/data.ts");

/** A route as the server registers it: `GET /api/crew`, `POST /api/seats/:id/start`. */
type RouteKey = string;

const config: CcConfig = {
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};

/**
 * Every route the real app registers (the `onRoute` table), HEAD twins left out. `/mcp` is not
 * among them, by design: it is registered only when `tokens` is given (not here), it is not under
 * `/api`, and its reader is the CLI, not the web; `mcp.test.ts` asserts its route-table entry.
 */
async function registeredRoutes(): Promise<RouteKey[]> {
  const dir = mkdtempSync(join(tmpdir(), "mc-routes-"));
  const store = new Store(join(dir, "mc.sqlite"));
  const app = buildApp({ config, store, bus: new ChangeBus() });
  const keys: RouteKey[] = [];
  app.addHook("onRoute", (r) => {
    for (const m of [r.method].flat()) if (m !== "HEAD") keys.push(`${m} ${r.url}`);
  });
  await app.ready();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  return keys;
}

/** `${…}` holes and the query string out of a path the web builds. */
const normalise = (p: string): string => p.replace(/\?.*$/, "");

/**
 * What the web app asks of the API, as `METHOD /api/path` with `ID` for every filled hole: the
 * RESOURCES (GET) and ACTIONS (POST) it names its paths in, run with placeholder arguments, and
 * the event stream it opens.
 */
function webReads(): RouteKey[] {
  const out: RouteKey[] = [];
  const pathOf = (v: unknown): string | null => {
    if (typeof v === "string") return v;
    if (typeof v === "function") return pathOf((v as (...a: string[]) => unknown)("ID", "ID"));
    if (v !== null && typeof v === "object" && "path" in v) return pathOf(v.path);
    return null;
  };
  for (const [method, table] of [
    ["GET", RESOURCES],
    ["POST", ACTIONS],
  ] as const) {
    for (const v of Object.values(table)) {
      const p = pathOf(v);
      if (p !== null) out.push(`${method} ${normalise(p)}`);
    }
  }
  for (const m of readFileSync(WEB_DATA, "utf8").matchAll(/new EventSource\("([^"]+)"\)/g)) {
    out.push(`GET ${m[1]}`);
  }
  return out;
}

/** Whether a registered route (`:param` segments) is the route the web names (`ID` for a hole). */
function matches(route: RouteKey, web: RouteKey): boolean {
  const [rm, rp = ""] = route.split(" ");
  const [wm, wp = ""] = web.split(" ");
  if (rm !== wm) return false;
  const r = rp.split("/");
  const w = wp.split("/");
  return r.length === w.length && r.every((seg, i) => seg.startsWith(":") || seg === w[i]);
}

/**
 * `// Reader: <where>` comments in api.ts, keyed by the route statement under each. The route's
 * path is a string literal, or a constant api.ts exports (e.g. `GUARD_CHECK_ROUTE`).
 */
function readerComments(): Map<RouteKey, string> {
  const lines = readFileSync(API_SRC, "utf8").split("\n");
  const out = new Map<RouteKey, string>();
  const exported = apiModule as Record<string, unknown>;
  lines.forEach((line, i) => {
    const text = /^\s*\/\/ Reader: (.*\S)\s*$/.exec(line)?.[1];
    if (text === undefined) return;
    const rest = lines.slice(i + 1, i + 9).join("\n");
    const literal = /\bapi\.(get|post|put|delete)\b[^"]*"(\/[^"]*)"/.exec(rest);
    const named = /\bapi\.(get|post|put|delete)\(\s*([A-Z][A-Z0-9_]*)\s*,/.exec(rest);
    const constPath = named ? exported[named[2] as string] : undefined;
    // the nearer route statement wins: a named path ahead of a later literal is the route
    if (named && typeof constPath === "string" && (!literal || named.index < literal.index)) {
      out.set(`${(named[1] as string).toUpperCase()} /api${constPath}`, text);
    } else if (literal) {
      out.set(`${(literal[1] as string).toUpperCase()} /api${literal[2]}`, text);
    }
  });
  return out;
}

const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Why a Reader comment does not name a reader, else null: it must name a file that exists in the
 * repo (`docs/runbook.md`), and with `#fragment` a heading of that markdown file or a symbol in
 * that source file (`apps/web/src/data.ts#RESOURCES`).
 */
function readerProblem(text: string, root = ROOT): string | null {
  const m = /([\w./-]+\.(?:md|tsx?|sh|json|ya?ml))(?:#([\w-]+))?/.exec(text);
  if (!m) return "names no file";
  const [, file = "", fragment] = m;
  const path = join(root, file);
  if (!existsSync(path)) return `${file} does not exist`;
  if (fragment === undefined) return null;
  const body = readFileSync(path, "utf8");
  if (file.endsWith(".md")) {
    const headings = body.split("\n").filter((l) => /^#+ /.test(l));
    return headings.some((h) => slug(h.replace(/^#+ /, "")) === fragment)
      ? null
      : `${file} has no heading #${fragment}`;
  }
  return body.includes(fragment) ? null : `${file} has no ${fragment}`;
}

/** Routes the web does not read and no valid Reader comment covers. */
function orphans(routes: RouteKey[], web: RouteKey[], readers: Map<RouteKey, string>): RouteKey[] {
  return routes.filter(
    (r) =>
      !web.some((w) => matches(r, w)) &&
      !(readers.has(r) && readerProblem(readers.get(r) as string) === null),
  );
}

describe("the route table", () => {
  it("has no route without a reader: the web reads it, or a `// Reader:` comment names who does", async () => {
    const routes = await registeredRoutes();
    expect(routes.length).toBeGreaterThan(30);
    expect(routes).toContain("GET /api/crew");
    expect(routes).toContain("GET /api/activity");
    expect(routes).toContain("GET /api/away/digest");
    expect(routes).toContain("GET /api/stream");
    expect(routes).toContain("GET /api/drafts/history");
    expect(routes).toContain("POST /api/drafts/:id/copied");
    expect(routes).toContain("GET /api/sources/teams");
    expect(routes).toContain("POST /api/sources/teams/selection");
    expect(routes).toContain("GET /api/notification-preferences");
    expect(routes).toContain("POST /api/notification-preferences");
    expect(routes).toContain("GET /api/notifications/events");
    expect(routes).toContain("POST /api/notifications/test");
    expect(routes).toContain("GET /api/accounts/status");
    expect(routes).toContain("POST /api/accounts/:id/check");
    expect(routes).toContain("POST /api/accounts");
    expect(routes).toContain("POST /api/profiles");
    expect(routes).toContain("GET /api/flight/incoming");
    expect(routes).toContain("GET /api/flight/schedule");
    expect(routes).toContain("GET /api/flight/summary");
    expect(routes).toContain("GET /api/flight/ledger");
    expect(routes).toContain("GET /api/flight/memory");
    expect(routes).toContain("PUT /api/flight/memory/:repo/:topic");
    expect(routes).toContain("DELETE /api/flight/memory/:repo/:topic");
    expect(routes).toContain("POST /api/seats/:id/start");
    expect(routes).toContain("GET /api/attention/:key/discussion");
    expect(routes).toContain("POST /api/attention/:key/discussion");
    expect(routes).toContain("GET /api/comms/:id");
    expect(routes).toContain("POST /api/comms/:id/read");
    expect(orphans(routes, webReads(), readerComments())).toEqual([]);
  });

  it("every Reader comment sits on a registered route and names a real reader", async () => {
    const routes = await registeredRoutes();
    const readers = readerComments();
    expect(readers.size).toBeGreaterThan(0);
    for (const [key, text] of readers) {
      expect(routes, key).toContain(key);
      expect(readerProblem(text), `${key}: ${text}`).toBeNull();
    }
  });

  it("POST /api/github/refresh has a Reader comment that names a real reader", () => {
    const text = readerComments().get("POST /api/github/refresh");
    expect(text).toBeDefined();
    expect(readerProblem(text as string)).toBeNull();
  });

  it("GET /api/stream names its EventSource reader", () => {
    const text = readerComments().get("GET /api/stream");
    expect(text).toBeDefined();
    expect(text).toContain("apps/web/src/data.ts#startStream");
    expect(readerProblem(text as string)).toBeNull();
  });

  it("matches by method as well as path", () => {
    const web = ["GET /api/crew", "POST /api/attention/ack"];
    expect(orphans(["GET /api/crew"], web, new Map())).toEqual([]);
    expect(orphans(["POST /api/crew", "PUT /api/attention/ack"], web, new Map())).toEqual([
      "POST /api/crew",
      "PUT /api/attention/ack",
    ]);
    expect(orphans(["GET /api/boards/:repoId"], ["GET /api/boards/ID"], new Map())).toEqual([]);
  });

  it("a Reader comment must name an existing file, and a heading or symbol in it", () => {
    expect(readerProblem("docs/runbook.md#project-fields (board setup)")).toBeNull();
    expect(readerProblem("apps/web/src/data.ts#RESOURCES")).toBeNull();
    expect(readerProblem("the runbook, probably")).toBe("names no file");
    expect(readerProblem("docs/nope.md")).toBe("docs/nope.md does not exist");
    expect(readerProblem("docs/runbook.md#no-such-heading")).toBe(
      "docs/runbook.md has no heading #no-such-heading",
    );
    expect(readerProblem("apps/web/src/data.ts#NoSuchThing")).toBe(
      "apps/web/src/data.ts has no NoSuchThing",
    );
    const reader = new Map([["GET /api/x", "nothing in particular"]]);
    expect(orphans(["GET /api/x"], [], reader)).toEqual(["GET /api/x"]);
  });
});
