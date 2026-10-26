import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@mc/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reactComms, sendComms, threadMessages } from "../src/comms.ts";
import { Store } from "../src/store.ts";
import * as stream from "../src/stream.ts";

let dir: string;
let path: string;
let store: Store;
const frame = (text: string) =>
  `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`;
const messages = () => threadMessages(store, "seat", true);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-comms-"));
  path = join(dir, "transcript.jsonl");
  store = new Store(":memory:");
  const run: Run = {
    id: "r",
    agentId: "seat",
    repoId: "repo",
    seq: 1,
    startedAt: 1,
    endedAt: null,
    status: "running",
    sessionId: null,
    model: null,
    branch: null,
    ticket: null,
    costUsd: null,
    tokens: null,
    transcriptPath: path,
    prs: [],
    summary: null,
  };
  store.upsertRun(run);
  writeFileSync(path, frame("first"));
  vi.spyOn(stream, "readStream");
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it("stores labels, reply mentions and reactions without waking for a reaction", async () => {
  const notify = vi.fn();
  const first = await sendComms(
    {
      store,
      crew: ["seat", "other"],
      knownSecrets: async () => [],
      now: () => 10,
      notify,
      seatSender: true,
    },
    "seat",
    { to: "other", text: "hello @other", label: "question", ref: "#7" },
  );
  const reply = await sendComms(
    {
      store,
      crew: ["seat", "other"],
      knownSecrets: async () => [],
      now: () => 11,
      notify,
      seatSender: true,
    },
    "other",
    { to: "seat", text: "reply", replyTo: first.id },
  );
  expect(reply.mentions).toEqual(["seat"]);
  expect(store.commsMessage(first.id)).toMatchObject({
    label: "question",
    ref: "#7",
    mentions: ["other"],
  });
  reactComms(store, "other", first.id, "seen", undefined, 12);
  expect(notify).toHaveBeenCalledTimes(2);
});

it("reuses parsed transcripts across thread and attention reads", () => {
  expect(messages()[0]?.text).toBe("first");
  expect(threadMessages(store, "seat", true, "attention")).toEqual(messages());
  expect(stream.readStream).toHaveBeenCalledTimes(1);
});

it("invalidates when size changes even with the same mtime", () => {
  utimesSync(path, 100, 100);
  messages();
  writeFileSync(path, frame("longer message"));
  utimesSync(path, 100, 100);
  expect(messages()[0]?.text).toBe("longer message");
  expect(stream.readStream).toHaveBeenCalledTimes(2);
});

it("invalidates when mtime changes with the same size", () => {
  messages();
  const before = statSync(path);
  writeFileSync(path, frame("other"));
  utimesSync(path, before.atime, new Date(before.mtimeMs + 2000));
  expect(statSync(path).size).toBe(before.size);
  expect(messages()[0]?.text).toBe("other");
  expect(stream.readStream).toHaveBeenCalledTimes(2);
});

it("drops deleted transcripts and re-reads a recreated file with the same metadata", () => {
  utimesSync(path, 100, 100);
  messages();
  rmSync(path);
  expect(messages()).toEqual([]);
  writeFileSync(path, frame("other"));
  utimesSync(path, 100, 100);
  expect(messages()[0]?.text).toBe("other");
  expect(stream.readStream).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "evicts the least recently used of 129 paths (reuse oldest: %s)",
  (reuse) => {
    const run = store.run("r");
    if (!run) throw new Error("missing run fixture");
    const read = (index: number) => {
      store.upsertRun({ ...run, transcriptPath: join(dir, `${index}.jsonl`) });
      expect(messages()[0]?.text).toBe(String(index));
    };
    for (let i = 0; i < 129; i++) writeFileSync(join(dir, `${i}.jsonl`), frame(String(i)));
    for (let i = 0; i < 128; i++) read(i);
    expect(stream.readStream).toHaveBeenCalledTimes(128);
    if (reuse) read(0);
    read(128);
    expect(stream.readStream).toHaveBeenCalledTimes(129);
    read(reuse ? 0 : 1);
    expect(stream.readStream).toHaveBeenCalledTimes(129);
    read(reuse ? 1 : 0);
    expect(stream.readStream).toHaveBeenCalledTimes(130);
  },
);
