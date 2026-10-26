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
      crew: () => ["seat", "other"],
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
      crew: () => ["seat", "other"],
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

it("notifies direct recipients, mentions and reply authors once each", async () => {
  const notify = vi.fn();
  const deps = {
    store,
    crew: () => ["seat", "other"],
    knownSecrets: async () => [],
    now: () => 10,
    notify,
    seatSender: true,
  };
  const original = await sendComms(deps, "seat", { to: "crew", text: "@other please look" });
  await sendComms(deps, "other", {
    to: "crew",
    text: "@seat acknowledged",
    replyTo: original.id,
  });

  expect(notify).toHaveBeenNthCalledWith(1, "other", "@other please look", "seat");
  expect(notify).toHaveBeenNthCalledWith(2, "seat", "@seat acknowledged", "other");
  expect(notify).toHaveBeenCalledTimes(2);
});

it("delivers CAPCOM direct Comms but never wakes for the CAPCOM channel or a reaction", async () => {
  const notify = vi.fn();
  const deps = {
    store,
    crew: () => ["seat", "other"],
    knownSecrets: async () => [],
    notify,
    seatSender: false,
  };
  const direct = await sendComms(deps, "CAPCOM", { to: "seat", text: "direct" });
  await sendComms(deps, "seat", { to: "CAPCOM", text: "channel" });
  reactComms(store, "seat", direct.id, "seen", undefined, 12);

  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith("seat", "direct", "CAPCOM");
});

it.each(["seat", "other"])(
  "does not store or deliver after a deferred secret scan removes %s from the crew",
  async (removed) => {
    let crew = ["seat", "other"];
    let resolveSecrets: (secrets: readonly string[]) => void = () => {};
    const notify = vi.fn();
    const pending = sendComms(
      {
        store,
        crew: () => crew,
        knownSecrets: () =>
          new Promise<readonly string[]>((resolve) => {
            resolveSecrets = resolve;
          }),
        notify,
        seatSender: true,
      },
      "seat",
      { to: "other", text: "hello" },
    );

    crew = crew.filter((id) => id !== removed);
    resolveSecrets([]);

    await expect(pending).rejects.toThrow("Unknown Comms");
    expect(store.comms(0)).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  },
);

it("refuses guessed private messages for reactions and replies", async () => {
  const deps = {
    store,
    crew: () => ["seat", "other", "third"],
    knownSecrets: async () => [],
    seatSender: true,
  };
  const privateMessage = await sendComms(deps, "seat", { to: "other", text: "private" });

  expect(() => reactComms(store, "third", privateMessage.id, "seen", undefined, 12)).toThrow(
    "You cannot react to that Comms message.",
  );
  await expect(
    sendComms(deps, "third", { to: "seat", text: "guess", replyTo: privateMessage.id }),
  ).rejects.toThrow("You cannot reply to that Comms message.");

  expect(store.setCommsPinned(privateMessage.id, true, "CAPCOM", 13)).toBe(true);
  expect(() => reactComms(store, "third", privateMessage.id, "seen", undefined, 14)).not.toThrow();
});

it("builds an inbox from direct, mention, reply and pinned messages without duplicates", async () => {
  let at = 10;
  const deps = {
    store,
    crew: () => ["seat", "other"],
    knownSecrets: async () => [],
    now: () => at++,
    seatSender: true,
  };
  const direct = await sendComms(deps, "other", { to: "seat", text: "direct" });
  const mentioned = await sendComms(deps, "other", { to: "crew", text: "@seat mention" });
  const original = await sendComms(deps, "seat", { to: "crew", text: "original" });
  const reply = await sendComms(deps, "other", { to: "crew", text: "reply", replyTo: original.id });
  const pinned = await sendComms(deps, "other", { to: "other", text: "pinned" });
  expect(store.setCommsPinned(pinned.id, true, "CAPCOM", at++)).toBe(true);

  expect(store.commsInbox("seat").map((row) => row.id)).toEqual([
    direct.id,
    mentioned.id,
    reply.id,
    pinned.id,
  ]);
});

it("keeps CAPCOM mentions newest first and finds boundary-safe ticket refs", async () => {
  let at = 10;
  const deps = {
    store,
    crew: () => ["seat", "other"],
    knownSecrets: async () => [],
    now: () => at++,
    seatSender: true,
  };
  const first = await sendComms(deps, "seat", { to: "crew", text: "@CAPCOM first #703" });
  const falseMatch = await sendComms(deps, "seat", { to: "crew", text: "#7030 is different" });
  const second = await sendComms(deps, "other", {
    to: "crew",
    text: "@CAPCOM second",
    ref: "#703",
  });

  expect(store.commsMentions("CAPCOM").map((row) => row.id)).toEqual([second.id, first.id]);
  expect(store.commsForTicket("#703").rows.map((row) => row.id)).toEqual([first.id, second.id]);
  expect(store.commsForTicket("#703").rows.map((row) => row.id)).not.toContain(falseMatch.id);
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
