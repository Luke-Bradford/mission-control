import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
      expect((await app.inject("/api/drafts")).json()).toEqual(store.drafts(true));
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
      expect((await app.inject("/api/drafts")).json()).toEqual([]);
      expect((await app.inject("/api/drafts/history")).json()).toEqual([
        expect.objectContaining({
          id,
          state: "posted",
          text: "Operator edited text",
          completedAt: expect.any(Number),
        }),
      ]);
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
    expect((await app.inject("/api/drafts/history")).json()).toEqual([
      expect.objectContaining({ id, state: "discarded", completedAt: expect.any(Number) }),
    ]);
    expect(
      (await app.inject({ method: "POST", url: `/api/drafts/${id}/discard`, payload: {} }))
        .statusCode,
    ).toBe(404);
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

it("retains bounded completion history across restart without counting it as pending", async () => {
  const pending = store.addDraft("mc#1", "issue", "Still waiting", 1);
  for (let i = 0; i < 105; i++) {
    const id = store.addDraft("mc#2", "pr", "Earlier reply", i + 2);
    store.finishDraft(id, i % 2 ? "posted" : "discarded", undefined, i + 200);
    store.finishDraft(id, "posted", "Must not overwrite", i + 300);
  }
  store.close();
  store = new Store(join(dir, "mc.sqlite"));
  expect(store.drafts()).toEqual([expect.objectContaining({ id: pending })]);
  const history = store.drafts(true);
  expect(history).toHaveLength(101);
  expect(history.filter((d) => d.state !== "pending")).toHaveLength(100);
  expect(history.find((d) => d.id === 2)).toBeUndefined();
  expect(history.find((d) => d.id === 106)).toMatchObject({
    state: "discarded",
    completedAt: 304,
    text: "Earlier reply",
  });
  expect(history.find((d) => d.id === pending)).toMatchObject({
    to: "mc#1",
    via: "GitHub",
    where: "mc#1",
  });
  expect(history.find((d) => d.id === pending)?.completedAt).toBeUndefined();
});

it("migrates legacy pending and posted rows without inventing a completion time", () => {
  const path = join(dir, "legacy.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, kind TEXT NOT NULL,
    text TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
  );
  INSERT INTO drafts (target, kind, text, created_at, state) VALUES
    ('mc#7', 'issue', 'Pending reply', 1, 'pending'),
    ('mc#8', 'pr', 'Earlier reply', 2, 'posted');`);
  db.close();
  const migrated = new Store(path);
  try {
    expect(migrated.drafts()).toHaveLength(1);
    expect(migrated.drafts(true)).toEqual([
      {
        id: 2,
        target: "mc#8",
        kind: "pr",
        text: "Earlier reply",
        createdAt: 2,
        state: "posted",
        to: "mc#8",
        via: "GitHub",
        where: "mc#8",
      },
      {
        id: 1,
        target: "mc#7",
        kind: "issue",
        text: "Pending reply",
        createdAt: 1,
        state: "pending",
        to: "mc#7",
        via: "GitHub",
        where: "mc#7",
      },
    ]);
  } finally {
    migrated.close();
  }
});

it("never posts a Teams draft on GitHub", async () => {
  const id = store.addDraft("mc#1", "issue", "Reply to copy", 1, {
    via: "Teams",
    to: "Preview team",
    where: "Preview channel",
  });
  expect((await post(id)).statusCode).toBe(400);
  expect(gh).not.toHaveBeenCalled();
  expect(store.drafts()).toHaveLength(1);
});

it("serves only pending drafts alongside bounded history ordered by completion, newest first", async () => {
  const pending = store.addDraft("mc#1", "issue", "Still waiting", 1000);
  const finished = [];
  for (let i = 0; i < 105; i++) {
    const metadata = {
      to: `Recipient ${i}`,
      via: i % 3 === 0 ? ("Teams" as const) : ("GitHub" as const),
      where: `Place ${i}`,
      context: `Context ${i}`,
    };
    // Creation order deliberately differs from completion order.
    const id = store.addDraft("mc#2", "pr", `Reply ${i}`, 200 - i, metadata);
    const state = i % 3 === 0 ? "copied" : i % 3 === 1 ? "posted" : "discarded";
    store.finishDraft(id, state, undefined, 300 + Math.floor(i / 2));
    finished.push({
      id,
      target: "mc#2",
      kind: "pr",
      text: `Reply ${i}`,
      createdAt: 200 - i,
      state,
      ...metadata,
      completedAt: 300 + Math.floor(i / 2),
    });
  }
  expect((await app.inject("/api/drafts")).json()).toEqual([
    {
      id: pending,
      target: "mc#1",
      kind: "issue",
      text: "Still waiting",
      createdAt: 1000,
      state: "pending",
      to: "mc#1",
      via: "GitHub",
      where: "mc#1",
    },
  ]);
  const response = await app.inject("/api/drafts/history");
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(finished.reverse().slice(0, 100));
});
