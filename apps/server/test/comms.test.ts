import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@mc/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  attentionChatter,
  COMMS_INBOX_PROMPT_MAX,
  COMMS_INBOX_PROMPT_ROWS,
  commsInboxContext,
  commsInboxPrompt,
  reactComms,
  resolvedCommsReason,
  sendComms,
  threadMessages,
} from "../src/comms.ts";
import { Store } from "../src/store.ts";
import * as stream from "../src/stream.ts";

let dir: string;
let path: string;
let store: Store;
const frame = (text: string) =>
  `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`;
const messages = () => threadMessages(store, "seat", true);

it("retires a question when CAPCOM marks it done and records the resolution", () => {
  const m = store.addComms({
    at: 4,
    from: "seat",
    to: "CAPCOM",
    ticket: null,
    text: "@CAPCOM Which option?",
    label: "question",
    mentions: ["CAPCOM"],
  });
  if (!m) throw new Error("missing message");
  expect(attentionChatter(store, "seat", true, false).tag).toHaveLength(1);
  reactComms(store, "CAPCOM", m.id, "done", undefined, 5);
  expect(attentionChatter(store, "seat", true, false).tag).toEqual([]);
  expect(store.openCommsItems()).toEqual([]);
  expect(store.hubEvents(0)[0]?.text).toContain("marked done");
});

it("keeps an ended run's old question resolved after its sender starts another run", () => {
  const m = store.addComms({
    at: 4,
    from: "seat",
    to: "CAPCOM",
    ticket: null,
    text: "Which option?",
  });
  if (!m) throw new Error("missing message");
  expect(resolvedCommsReason(store, m)).toBeNull();
  const old = store.run("r");
  if (!old) throw new Error("missing run");
  store.upsertRun({ ...old, endedAt: 5 });
  store.upsertRun({ ...old, id: "next", seq: 2, startedAt: 6 });
  expect(store.commsRun(m.id)?.id).toBe("r");
  expect(resolvedCommsReason(store, m)).toBe("The related run ended.");
});

it("keeps a qualified PR question and its reply in the same repository thread", async () => {
  const deps = {
    store,
    crew: () => ["seat", "other"],
    knownSecrets: async () => [],
    senderKind: "seat" as const,
  };
  const question = await sendComms(
    { ...deps, ticket: "repo#42", senderKind: "operator" },
    "CAPCOM",
    {
      to: "seat",
      ref: "PR 7",
      label: "question",
      text: "What did QA test?",
    },
  );
  const reply = await sendComms(deps, "seat", {
    to: "CAPCOM",
    ref: "PR 7",
    replyTo: question.id,
    text: "Both themes.",
  });
  expect(question.ticket).toBe("repo#42");
  expect(reply.ticket).toBe("repo#42");
  expect(reply.ref).toBe("PR 7");
});

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
      senderKind: "seat" as const,
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
      senderKind: "seat" as const,
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
  expect(notify).toHaveBeenCalledTimes(1);
});

it("notifies direct recipients, mentions and reply authors once each", async () => {
  const notify = vi.fn();
  const deps = {
    store,
    crew: () => ["seat", "other"],
    knownSecrets: async () => [],
    senderKind: "seat" as const,
    now: () => 10,
    notify,
    seatSender: true,
  };
  const original = await sendComms(deps, "seat", {
    to: "crew",
    text: "@other please look",
    label: "handoff",
  });
  await sendComms(deps, "other", {
    to: "crew",
    text: "@seat acknowledged",
    replyTo: original.id,
    label: "handoff",
  });

  expect(notify).toHaveBeenNthCalledWith(1, "other", "@other please look", "seat");
  expect(notify).toHaveBeenNthCalledWith(2, "seat", "@seat acknowledged", "other");
  expect(notify).toHaveBeenCalledTimes(2);
});

it("wakes for labelled CAPCOM direct Comms but not FYI, channel posts or reactions", async () => {
  const notify = vi.fn();
  const deps = {
    store,
    crew: () => ["seat", "other"],
    knownSecrets: async () => [],
    senderKind: "seat" as const,
    notify,
    seatSender: false,
  };
  const asOperator = { ...deps, senderKind: "operator" as const };
  const direct = await sendComms(asOperator, "CAPCOM", {
    to: "seat",
    text: "direct",
    label: "handoff",
  });
  await sendComms(asOperator, "CAPCOM", { to: "seat", text: "FYI" });
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
        senderKind: "seat",
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
    senderKind: "seat" as const,
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
    senderKind: "seat" as const,
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

it("caps a turn inbox at 40 messages or 8k characters, keeping the newest", () => {
  const ids: string[] = [];
  for (let n = 0; n < COMMS_INBOX_PROMPT_ROWS + 8; n++)
    ids.push(
      store.addComms({
        at: n,
        from: "other",
        to: "seat",
        ticket: null,
        text: `${n} ${"x".repeat(500)}`,
        targetRunId: "r",
      })?.id ?? "",
    );
  const inbox = commsInboxContext(store, "seat", "r");
  const prompt = inbox.text;
  expect(prompt.length).toBeLessThanOrEqual(COMMS_INBOX_PROMPT_MAX);
  expect(prompt).toContain("older: use comms_inbox");
  expect(prompt).toContain('"text":"47 ');
  expect(prompt).not.toContain('"text":"0 ');
  expect(store.commsInboxRead("seat", ids[0] ?? "")).toBe(false);
  store.markCommsInboxRead("seat", inbox.messageIds);
  expect(store.commsInboxRead("seat", ids.at(-1) ?? "")).toBe(true);
});

it("keeps a current pin in an inbox across target runs", () => {
  const pinned = store.addComms({
    at: 1,
    from: "other",
    to: "seat",
    ticket: null,
    text: "pinned old run",
    targetRunId: "old-run",
  });
  if (pinned === null) throw new Error("expected pinned Comms row");
  expect(store.setCommsPinned(pinned.id, true, "CAPCOM", 2)).toBe(true);
  expect(store.commsInboxRun("seat", "r").map((row) => row.id)).toContain(pinned.id);
});

it("keeps the newest oversized inbox row and marks delivered rows read", () => {
  const first = store.addComms({
    at: 1,
    from: "other",
    to: "seat",
    ticket: null,
    text: "first",
    targetRunId: "r",
  });
  const newest = store.addComms({
    at: 2,
    from: "other",
    to: "seat",
    ticket: null,
    text: "newest ".repeat(2_000),
    targetRunId: "r",
  });
  if (first === null || newest === null) throw new Error("expected stored Comms rows");

  const inbox = commsInboxContext(store, "seat", "r");
  const delivered = inbox.text;
  expect(delivered.length).toBeLessThanOrEqual(COMMS_INBOX_PROMPT_MAX);
  expect(delivered).toContain(newest.id);
  expect(delivered).toContain("stored text cut");
  store.markCommsInboxRead("seat", inbox.messageIds);

  // delivered once: the next line does not carry it again
  const later = commsInboxPrompt(store, "seat", "r");
  expect(later).not.toContain(newest.id);
  expect(later).not.toContain('"unread":false');
});

it("does not attach a message already sent to a seat to its next delivered line", () => {
  const first = store.addComms({
    at: 1,
    from: "other",
    to: "seat",
    ticket: null,
    text: "first",
    targetRunId: "r",
  });
  if (first === null) throw new Error("expected stored Comms row");
  const start = commsInboxContext(store, "seat", "r");
  expect(start.text).toContain("first");
  store.markCommsInboxRead("seat", start.messageIds);
  const second = store.addComms({
    at: 2,
    from: "other",
    to: "seat",
    ticket: null,
    text: "second",
    targetRunId: "r",
  });
  if (second === null) throw new Error("expected stored Comms row");
  const next = commsInboxContext(store, "seat", "r");
  expect(next.messageIds).toEqual([second.id]);
  expect(next.text).toContain("second");
  expect(next.text).not.toContain("first");
  store.markCommsInboxRead("seat", next.messageIds);
  expect(commsInboxContext(store, "seat", "r").messageIds).toEqual([]);
});

it("stores a seat message with the sender's run ticket in repo#n form", async () => {
  const deps = {
    store,
    crew: () => ["seat", "other"],
    knownSecrets: async () => [],
    senderKind: "seat" as const,
    now: () => 10,
    seatSender: true,
    senderTicket: "mc#42",
  };
  const plain = await sendComms(deps, "seat", { to: "other", text: "no ticket given" });
  expect(plain.ticket).toBe("mc#42");
  // a short-form ref is stored in the one long form, not as #7
  const named = await sendComms(deps, "seat", { to: "other", text: "about seven", ref: "#7" });
  expect(named.ticket).toBe("mc#7");
  // a reply inherits the ticket of the message it answers, in the one form
  const old = store.addComms({ at: 1, from: "other", to: "seat", ticket: "#9", text: "old" });
  if (old === null) throw new Error("expected stored Comms row");
  const reply = await sendComms(deps, "seat", { to: "other", text: "reply", replyTo: old.id });
  expect(reply.ticket).toBe("mc#9");
});

it("stores an identical message sent again within a minute once, and counts the repeat", async () => {
  let at = 1_000;
  const notify = vi.fn();
  const deps = {
    store,
    crew: () => ["seat", "other"],
    knownSecrets: async () => [],
    senderKind: "seat" as const,
    now: () => at,
    seatSender: true,
    notify,
  };
  const input = { to: "other", text: "same words", label: "handoff" as const };
  const first = await sendComms(deps, "seat", input);
  expect(first.repeat).toBeUndefined();
  at += 3_000;
  const again = await sendComms(deps, "seat", input);
  expect(again.id).toBe(first.id);
  expect(again.repeat).toBe(true);
  expect(store.comms(0)).toHaveLength(1);
  expect(store.commsRepeatCount(0)).toBe(1);
  // the recipient is woken by the first copy only
  expect(notify).toHaveBeenCalledTimes(1);
  // a different recipient or text is not a repeat; the same text after the window is stored
  await sendComms(deps, "seat", { ...input, to: "crew" });
  at += 61_000;
  const later = await sendComms(deps, "seat", input);
  expect(later.id).not.toBe(first.id);
  expect(store.comms(0)).toHaveLength(3);
});

it("keeps CAPCOM mentions newest first and finds boundary-safe ticket refs", async () => {
  let at = 10;
  const deps = {
    store,
    crew: () => ["seat", "other"],
    knownSecrets: async () => [],
    senderKind: "seat" as const,
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

it("closes an open question on the addressee's seen reaction, not anyone else's", () => {
  const m = store.addComms({
    at: 4,
    from: "seat",
    to: "other",
    ticket: null,
    text: "Which option?",
    label: "question",
  });
  if (!m) throw new Error("missing message");
  store.addCommsReaction(m.id, "third", "seen", undefined, 5);
  expect(store.openCommsItems().map((i) => i.id)).toEqual([m.id]);
  reactComms(store, "other", m.id, "seen", undefined, 6);
  expect(store.openCommsItems()).toEqual([]);
});
