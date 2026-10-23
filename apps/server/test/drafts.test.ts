import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import type { GhRunner } from "../src/mcp/gh.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import { Store } from "../src/store.ts";

const config: CcConfig = {
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [],
  loops: [],
  repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "draft" }],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};
let dir: string;
let store: Store;
let app: FastifyInstance;
let gh: ReturnType<typeof vi.fn<GhRunner>>;
let token: string;
let bodyFile: string;
let posted: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-drafts-"));
  store = new Store(join(dir, "mc.sqlite"));
  bodyFile = "";
  posted = "";
  gh = vi.fn(async (args) => {
    bodyFile = args.find((a) => a.startsWith("--body-file="))?.slice(12) ?? "";
    expect(statSync(bodyFile).mode & 0o777).toBe(0o600);
    posted = readFileSync(bodyFile, "utf8");
    return { code: 0, stdout: "", stderr: "" };
  });
  const tokens = new RunTokens();
  token = tokens.issue("flight-1", "r-flight");
  app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    gh,
    knownSecrets: async () => ["private-test-secret"],
    tokens,
  });
});
afterEach(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const post = (id: number, text?: string) =>
  app.inject({
    method: "POST",
    url: `/api/drafts/${id}/post`,
    payload: text === undefined ? {} : { text },
  });

describe("operator draft approval", () => {
  it.each(["issue", "pr"] as const)(
    "posts %s once through gh with edited text in a private temporary file",
    async (kind) => {
      const id = store.addDraft("mc#12", kind, "Prepared text", 123);
      expect((await app.inject("/api/drafts")).json()).toEqual(store.drafts());
      expect((await post(id, "Operator edited text")).statusCode).toBe(200);
      expect(gh).toHaveBeenCalledTimes(1);
      expect(gh.mock.calls[0]?.[0]).toEqual([
        kind,
        "comment",
        "12",
        "--repo=o/mc",
        `--body-file=${bodyFile}`,
      ]);
      expect(posted).toBe("Operator edited text");
      expect(existsSync(bodyFile)).toBe(false);
      expect(store.drafts()).toEqual([]);
      expect((await post(id)).statusCode).toBe(404);
      expect(gh).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects non-JSON and foreign-origin approval requests", async () => {
    const id = store.addDraft("mc#1", "issue", "Reply", 1);
    for (const headers of [
      { "content-type": "text/plain" },
      { "content-type": "application/x-www-form-urlencoded" },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/drafts/${id}/post`,
            headers,
            payload: "{}",
          })
        ).statusCode,
      ).toBe(415);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/drafts/${id}/post`,
          headers: { origin: "https://evil.example" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(gh).not.toHaveBeenCalled();
    expect(store.drafts()).toHaveLength(1);
  });

  it.each([
    "unknown#1",
    "https://github.com/o/mc/issues/1",
    "mc#0",
    "mc#-1",
    "mc#1 --help",
    "mc#99999999999999999999",
  ])("refuses invalid target %s even if stored", async (target) => {
    const id = store.addDraft(target, "issue", "Reply", 1);
    expect((await post(id)).statusCode).toBe(400);
    expect(gh).not.toHaveBeenCalled();
  });

  it.each([
    "@someone please look",
    "private-test-secret",
    "```unclosed",
    "See other/repo#123",
    "&commat;someone",
  ])("refuses unsafe text with its reason: %s", async (text) => {
    const id = store.addDraft("mc#1", "pr", "Safe text", 1);
    const response = await post(id, text);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBeTruthy();
    expect(gh).not.toHaveBeenCalled();
    expect(store.drafts()).toHaveLength(1);
  });

  it("lets a reply name the repo's own issues, as FLIGHT's comments may", async () => {
    const id = store.addDraft("mc#1", "issue", "Fixed in #5", 1);
    expect((await post(id)).statusCode).toBe(200);
    expect(posted).toBe("Fixed in #5");
  });

  it("scans stored text too, and keeps failed GitHub posts pending", async () => {
    const bad = store.addDraft("mc#1", "issue", "@someone", 1);
    expect((await post(bad)).statusCode).toBe(400);
    const id = store.addDraft("mc#2", "issue", "Safe reply", 2);
    gh.mockImplementationOnce(async () => ({ code: 1, stdout: "", stderr: "failure" }));
    expect((await post(id)).statusCode).toBe(502);
    expect(store.drafts()).toHaveLength(2);
  });

  it("cannot post via an authenticated MCP tool call or MCP path", async () => {
    const id = store.addDraft("mc#1", "issue", "Reply", 1);
    for (const name of ["post_draft", "draft_post", `/api/drafts/${id}/post`]) {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, text/event-stream",
        },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { id } },
        },
      });
      expect(response.json().error).toBeTruthy();
    }
    expect(
      (await app.inject({ method: "POST", url: `/mcp/drafts/${id}/post`, payload: {} })).statusCode,
    ).toBe(404);
    expect(gh).not.toHaveBeenCalled();
    expect(store.drafts()).toHaveLength(1);
  });

  it("discards the draft without calling GitHub", async () => {
    const id = store.addDraft("mc#1", "issue", "Reply", 1);
    expect(
      (await app.inject({ method: "POST", url: `/api/drafts/${id}/discard`, payload: {} }))
        .statusCode,
    ).toBe(200);
    expect((await app.inject("/api/drafts")).json()).toEqual([]);
    const next = store.addDraft("mc#2", "pr", "Another reply", 2);
    expect(next).not.toBe(id);
    expect((await post(id)).statusCode).toBe(404);
    expect(gh).not.toHaveBeenCalled();
  });

  it("blocks concurrent approval and discard while a post is running", async () => {
    const id = store.addDraft("mc#1", "issue", "Reply", 1);
    let release: () => void = () => {};
    let started: () => void = () => {};
    const ready = new Promise<void>((r) => {
      started = r;
    });
    gh.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((r) => {
        release = r;
      });
      return { code: 0, stdout: "", stderr: "" };
    });
    const first = post(id).then((r) => r);
    await ready;
    expect((await post(id)).statusCode).toBe(409);
    expect(
      (await app.inject({ method: "POST", url: `/api/drafts/${id}/discard`, payload: {} }))
        .statusCode,
    ).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
    expect(gh).toHaveBeenCalledTimes(1);
  });
});
