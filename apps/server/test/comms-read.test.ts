import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { COMMS_TEXT_MAX, type Run } from "@mc/core";
import { expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { threadMessages } from "../src/comms.ts";
import type { CcConfig } from "../src/config.ts";
import { attentionItems } from "../src/hud.ts";
import { Store } from "../src/store.ts";
import * as stream from "../src/stream.ts";
import { foldTranscript } from "../src/streamjson.ts";

it("keeps tags and direct replies stable across folds, reload, Ack and a read/arrival race", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-comms-"));
  const path = join(dir, "db.sqlite");
  let store = new Store(path);
  const config: CcConfig = {
    operator: { id: "operator", timezone: "UTC" },
    accounts: [],
    repos: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    loops: [
      {
        id: "guido-1",
        repoId: "demo",
        kind: "ta-loop",
        accountId: "demo",
        stateDir: "",
        worktree: "",
        launchdLabel: "demo",
      },
    ],
  };
  const add = (from: string, to: string, text: string) =>
    store.addComms({ from, to, text, at: 10, ticket: null });
  add("guido-1", "retro-1", "→ RETRO-1: @CAPCOM check the plan");
  add("CAPCOM", "guido-1", "@CAPCOM own send");
  add("guido-1", "CAPCOM", "Ready");
  add("guido-1", "retro-1", "Ordinary peer message");
  for (let i = 0; i < 201; i++) add("guido-1", "retro-1", "Peer update");
  const needs = () =>
    attentionItems(config, store, 20, undefined, []).filter((i) =>
      ["tag", "message"].includes(i.kind),
    );
  const first = needs();
  expect(first.map((i) => i.text).sort()).toEqual(
    ["1 new on your direct line", "@CAPCOM check the plan"].sort(),
  );
  expect(needs()).toEqual(first);
  store.close();
  store = new Store(path);
  expect(needs()).toEqual(first);
  const bus = new ChangeBus();
  const topics: string[] = [];
  bus.subscribe((t) => topics.push(t));
  const app = buildApp({ config, store, bus });
  try {
    const snapshot = (await app.inject({ url: "/api/comms/guido-1" })).json();
    const ack = await app.inject({
      method: "POST",
      url: "/api/attention/ack",
      payload: { keys: [first[0]?.key] },
    });
    expect(ack.statusCode).toBe(200);
    expect(needs().find((i) => i.key === first[0]?.key)?.acked).toBe(true);
    expect(needs()).toHaveLength(2);
    add("guido-1", "CAPCOM", "Later reply");
    const read = await app.inject({
      method: "POST",
      url: "/api/comms/guido-1/read",
      payload: { messageIds: snapshot.messages.map((m: { id: string }) => m.id) },
    });
    expect(read.statusCode).toBe(200);
    expect(needs().map((i) => i.text)).toEqual(["1 new on your direct line"]);
    expect(topics).toContain("attention");
    expect(topics).toContain("agents");
    expect(topics).not.toContain("comms");
    store.close();
    store = new Store(path);
    expect(needs().map((i) => i.text)).toEqual(["1 new on your direct line"]);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("uses stable transcript IDs through repeated folds and reads, preserving unknown times", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-thread-stream-"));
  const store = new Store(join(dir, "db.sqlite"));
  const config: CcConfig = {
    operator: { id: "operator", timezone: "UTC" },
    accounts: [],
    repos: [],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
  };
  const transcript = join(dir, "transcript.jsonl");
  const frame = (text: string, timestamp?: string) =>
    `${JSON.stringify({ type: "assistant", timestamp, message: { content: [{ type: "text", text }] } })}\n`;
  writeFileSync(transcript, frame("@CAPCOM earlier", "2026-10-23T10:00:00Z"));
  const run: Run = {
    id: "old",
    agentId: "guido-1",
    repoId: "demo",
    seq: 1,
    startedAt: 1,
    endedAt: 2,
    status: "ok",
    sessionId: null,
    model: null,
    branch: null,
    ticket: null,
    costUsd: null,
    tokens: null,
    transcriptPath: transcript,
    prs: [],
    summary: null,
  };
  store.upsertRun(run);
  const latest = join(dir, "latest.jsonl");
  writeFileSync(latest, frame("@CAPCOM latest", "2026-10-23T11:00:00Z") + frame("Undated reply"));
  store.upsertRun({ ...run, id: "new", seq: 2, startedAt: 3, transcriptPath: latest });
  config.crew = {
    worktrees: join(dir, "worktrees"),
    maxSeats: 1,
    sessions: [
      {
        id: "demo",
        repoId: "demo",
        checkout: join(dir, "checkout"),
        seats: [{ id: "guido-1", role: "GUIDO", accountId: "demo", model: "sonnet", area: [] }],
      },
    ],
  };
  store.addComms({ from: "CAPCOM", to: "guido-1", text: "Status?", at: 0, ticket: null });
  const app = buildApp({ config, store, bus: new ChangeBus() });
  const needs = () =>
    attentionItems(config, store, 20, undefined, []).filter((i) =>
      ["tag", "message"].includes(i.kind),
    );
  try {
    expect(needs().find((i) => i.kind === "tag")?.text).toBe("@CAPCOM latest");
    const snapshot = (await app.inject({ url: "/api/comms/guido-1" })).json();
    expect(
      snapshot.messages.find((m: { text: string }) => m.text === "Undated reply").at,
    ).toBeNull();
    const lines = [frame("@CAPCOM latest", "2026-10-23T11:00:00Z"), frame("Undated reply")];
    for (let i = 0; i < 2; i++) store.setDigest("new", foldTranscript(null, lines, 50).digest);
    expect((await app.inject({ url: "/api/comms/guido-1" })).json()).toEqual(snapshot);
    appendFileSync(latest, frame("Later reply"));
    const payload = { messageIds: snapshot.messages.map((m: { id: string }) => m.id) };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/comms/guido-1/read",
          payload: { messageIds: ["stream:new:9007199254740991:0"] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/comms/guido-1/read",
          headers: { origin: "https://elsewhere.invalid" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/comms/guido-1/read",
          headers: { "content-type": "text/plain" },
          payload: "{}",
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (await app.inject({ method: "POST", url: "/api/comms/unknown/read", payload })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/comms/guido-1/read",
          payload: { messageIds: ["invalid"] },
        })
      ).statusCode,
    ).toBe(400);

    for (let i = 0; i < 2; i++) {
      expect(
        (await app.inject({ method: "POST", url: "/api/comms/guido-1/read", payload })).statusCode,
      ).toBe(200);
      expect(needs().map((item) => item.text)).toEqual(["1 new on your direct line"]);
    }
    appendFileSync(latest, frame("More replies").repeat(201));
    expect(
      (await app.inject({ method: "POST", url: "/api/comms/guido-1/read", payload })).statusCode,
    ).toBe(200);
    expect(needs().map((item) => item.text)).toEqual(["200 new on your direct line"]);
    const current = (await app.inject({ url: "/api/comms/guido-1" })).json();
    expect(current.messages.filter((m: { seen: boolean }) => !m.seen)).toHaveLength(200);
    const readCurrent = await app.inject({
      method: "POST",
      url: "/api/comms/guido-1/read",
      payload: { messageIds: current.messages.map((m: { id: string }) => m.id) },
    });
    expect(readCurrent.statusCode).toBe(200);
    expect(needs()).toEqual([]);
    expect(
      (await app.inject({ method: "POST", url: "/api/comms/guido-1/read", payload })).statusCode,
    ).toBe(200);
    expect(needs()).toEqual([]);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function regressionFixture() {
  const dir = mkdtempSync(join(tmpdir(), "mc-comms-regression-"));
  const store = new Store(join(dir, "db.sqlite"));
  const config: CcConfig = {
    operator: { id: "operator", timezone: "UTC" },
    accounts: [],
    repos: [],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    crew: {
      worktrees: dir,
      maxSeats: 1,
      sessions: [
        {
          id: "demo",
          repoId: "demo",
          checkout: dir,
          seats: [{ id: "guido-1", role: "GUIDO", accountId: "demo", model: "sonnet", area: [] }],
        },
      ],
    },
  };
  const frame = (text: string, at: number) =>
    `${JSON.stringify({ type: "assistant", timestamp: new Date(at).toISOString(), message: { content: [{ type: "text", text }] } })}\n`;
  const addRun = (seq: number, text: string) => {
    const transcriptPath = join(dir, `${seq}.jsonl`);
    writeFileSync(transcriptPath, frame(text, seq * 1000));
    store.upsertRun({
      id: `run-${seq}`,
      agentId: "guido-1",
      repoId: "demo",
      seq,
      startedAt: seq,
      endedAt: null,
      status: "running",
      sessionId: null,
      model: null,
      branch: null,
      ticket: null,
      costUsd: null,
      tokens: null,
      transcriptPath,
      prs: [],
      summary: null,
    });
    return transcriptPath;
  };
  const needs = () =>
    attentionItems(config, store, 10000, undefined, []).filter(
      (i) => i.kind === "message" || i.kind === "tag",
    );
  return { dir, store, config, frame, addRun, needs };
}

it("reads only the latest transcript for Needs you and at most three for a thread", async () => {
  const f = regressionFixture();
  for (let i = 1; i <= 8; i++) f.addRun(i, `@CAPCOM run ${i}`);
  f.store.addComms({
    from: "guido-1",
    to: "retro-1",
    text: "@CAPCOM stored",
    at: 9000,
    ticket: null,
  });
  const read = vi.spyOn(stream, "readStream");
  const app = buildApp({ config: f.config, store: f.store, bus: new ChangeBus() });
  try {
    const items = f.needs();
    expect(read.mock.calls.map(([path]) => path)).toEqual([join(f.dir, "8.jsonl")]);
    expect(items.map((i) => i.text)).toEqual(["@CAPCOM stored"]);
    read.mockClear();
    const snapshot = (await app.inject({ url: "/api/comms/guido-1" })).json();
    // three runs scanned; run 8's transcript is unchanged since Needs you read it, so it comes from the cache
    expect(read.mock.calls.map(([path]) => path)).toEqual([
      join(f.dir, "6.jsonl"),
      join(f.dir, "7.jsonl"),
    ]);
    expect(
      snapshot.messages
        .filter((m: { id: string }) => m.id.startsWith("stream:"))
        .map((m: { text: string }) => m.text),
    ).toEqual(["@CAPCOM run 6", "@CAPCOM run 7", "@CAPCOM run 8"]);
  } finally {
    read.mockRestore();
    await app.close();
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

it("counts only replies after CAPCOM's latest direct message and clears them when opened", async () => {
  const f = regressionFixture();
  const path = f.addRun(1, "Unsolicited update");
  const app = buildApp({ config: f.config, store: f.store, bus: new ChangeBus() });
  try {
    expect(f.needs()).toEqual([]);
    f.store.addComms({
      from: "CAPCOM",
      to: "guido-1",
      text: "How is it going?",
      at: 2000,
      ticket: null,
    });
    appendFileSync(path, f.frame("First answer", 3000) + f.frame("Second answer", 4000));
    expect(f.needs().map((i) => i.text)).toEqual(["2 new on your direct line"]);
    const snapshot = (await app.inject({ url: "/api/comms/guido-1" })).json();
    expect(snapshot.messages.map((m: { direct: boolean }) => m.direct)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/comms/guido-1/read",
          payload: { messageIds: snapshot.messages.map((m: { id: string }) => m.id) },
        })
      ).statusCode,
    ).toBe(200);
    expect(f.needs()).toEqual([]);
    f.store.addComms({
      from: "CAPCOM",
      to: "guido-1",
      text: "Next question",
      at: 5000,
      ticket: null,
    });
    expect(
      (await app.inject({ url: "/api/comms/guido-1" }))
        .json()
        .messages.every((m: { direct: boolean }) => !m.direct),
    ).toBe(true);
  } finally {
    await app.close();
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

it("bounds stored history and indexes both thread endpoints", () => {
  const f = regressionFixture();
  try {
    for (let i = 0; i < 520; i++) {
      f.store.addComms({
        from: i % 2 ? "guido-1" : "peer",
        to: i % 2 ? "peer" : "guido-1",
        text: String(i),
        at: i,
        ticket: null,
      });
    }
    const rows = f.store.threadComms("guido-1");
    expect(rows).toHaveLength(500);
    expect(rows[0]?.text).toBe("20");
    expect(rows.at(-1)?.text).toBe("519");
    const db = new DatabaseSync(join(f.dir, "db.sqlite"));
    try {
      for (const column of ["from_id", "to_id"]) {
        const plan = db
          .prepare(
            `EXPLAIN QUERY PLAN SELECT * FROM comms WHERE ${column} = ? ORDER BY id DESC LIMIT 500`,
          )
          .all("guido-1");
        expect(plan.map((r) => r.detail).join(" ")).toContain("USING INDEX");
      }
    } finally {
      db.close();
    }
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

it("caps a long snapshot at the read route's accepted bound", async () => {
  const f = regressionFixture();
  const app = buildApp({ config: f.config, store: f.store, bus: new ChangeBus() });
  try {
    for (let i = 0; i < 10201; i++)
      f.store.addComms({ from: "guido-1", to: "CAPCOM", text: String(i), at: i, ticket: null });
    const snapshot = (await app.inject({ url: "/api/comms/guido-1" })).json();
    expect(snapshot.messages.length).toBeLessThanOrEqual(10200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/comms/guido-1/read",
          payload: { messageIds: snapshot.messages.map((m: { id: string }) => m.id) },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
  // 10,201 inserts take several seconds on a loaded CI runner
}, 30_000);

it("accepts a displayed snapshot after tools evict every message from its source", async () => {
  const f = regressionFixture();
  const path = f.addRun(1, "@CAPCOM displayed");
  const app = buildApp({ config: f.config, store: f.store, bus: new ChangeBus() });
  try {
    const snapshot = (await app.inject({ url: "/api/comms/guido-1" })).json();
    appendFileSync(
      path,
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "working" }] } })}\n`.repeat(
        201,
      ),
    );
    expect((await app.inject({ url: "/api/comms/guido-1" })).json().messages).toEqual([]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/comms/guido-1/read",
          payload: { messageIds: snapshot.messages.map((m: { id: string }) => m.id) },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

it("keeps undated tags in source order before later dated tags", () => {
  const f = regressionFixture();
  try {
    const path = f.addRun(1, "initial");
    appendFileSync(
      path,
      `${JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "@CAPCOM undated" },
            { type: "text", text: "@CAPCOM undated second block" },
          ],
        },
      })}\n${f.frame("@CAPCOM newest", 3000)}`,
    );
    expect(f.needs().find((i) => i.kind === "tag")?.text).toBe("@CAPCOM newest");
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

it("attention selects only unread stored bodies and retains a read prompt's reply context", () => {
  const f = regressionFixture();
  try {
    f.store.addComms({ from: "CAPCOM", to: "guido-1", text: "Prompt", at: 10, ticket: null });
    for (let i = 0; i < 10; i++) {
      f.store.addComms({
        from: "guido-1",
        to: "peer",
        text: "x".repeat(COMMS_TEXT_MAX),
        at: 11,
        ticket: null,
      });
    }
    const snapshot = f.store.threadComms("guido-1");
    f.store.markThreadRead(
      "guido-1",
      snapshot.map((m) => m.id),
    );
    f.store.addComms({ from: "guido-1", to: "CAPCOM", text: "Reply", at: 12, ticket: null });
    const query = vi.spyOn(f.store, "threadComms");
    const messages = threadMessages(f.store, "guido-1", true, "attention");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: "Reply", seen: false, direct: true });
    expect(query).toHaveBeenCalledWith("guido-1", Number(snapshot.at(-1)?.id.split(":")[1]));
    expect(query.mock.results[0]?.value).toHaveLength(1);
    expect(threadMessages(f.store, "guido-1", true)).toHaveLength(12);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
