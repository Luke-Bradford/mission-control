import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Message } from "../src/envelope.ts";
import { mayAutoReply, outgoingRate, similarOpen } from "../src/guards.ts";
import { openInbox } from "../src/inbox.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const question: Message = {
  id: "q",
  room: "room",
  thread: "thread",
  kind: "question",
  body: "Is #506 yours?",
  auto: false,
  sentAt: "2026-10-24T00:00:00Z",
};
it("never automatically replies to an automatic message", () => {
  expect(mayAutoReply({ ...question, auto: true })).toBe(false);
  expect(mayAutoReply(question)).toBe(true);
});
it("allows ten outgoing messages in a sliding minute", () => {
  let now = 0;
  const rate = outgoingRate(() => now);
  for (let i = 0; i < 10; i++) expect(rate.allow()).toBe(true);
  expect(rate.allow()).toBe(false);
  now = 59_999;
  expect(rate.allow()).toBe(false);
  now = 60_000;
  expect(rate.allow()).toBe(true);
});
it("persists sequence order, deduplicates replay, and merges only open questions in the room", () => {
  const dir = mkdtempSync(join(tmpdir(), "comms-inbox-"));
  dirs.push(dir);
  const path = join(dir, "inbox.sqlite");
  const inbox = openInbox(path);
  const sender = { id: "agent", kind: "agent" as const };
  inbox.add(2, "room", question, sender);
  inbox.add(
    1,
    "room",
    { ...question, id: "earlier", thread: "other", kind: "fyi", sentAt: "2099-01-01" },
    sender,
  );
  inbox.add(2, "room", question, sender);
  expect(inbox.list("room").map((entry) => entry.seq)).toEqual([1, 2]);
  expect(inbox.list("room", 1)).toHaveLength(1);
  expect(inbox.lastSeq("room")).toBe(2);
  expect(similarOpen("room", " is   #506 YOURS? ", inbox)).toBe("thread");
  expect(similarOpen("elsewhere", question.body, inbox)).toBeUndefined();
  inbox.dispose();
  const reopened = openInbox(path);
  expect(reopened.lastSeq("room")).toBe(2);
  reopened.close("thread");
  expect(similarOpen("room", question.body, reopened)).toBeUndefined();
  expect(reopened.threads("room")).toContainEqual(
    expect.objectContaining({ thread: "thread", closed: true }),
  );
  reopened.dispose();
});
it("answers close their question's thread without closing the same id in another room", () => {
  const inbox = openInbox(":memory:");
  const sender = { id: "human", kind: "human" as const };
  inbox.add(1, "room", question, sender);
  inbox.add(1, "other", { ...question, room: "other" }, sender);
  inbox.add(2, "room", { ...question, id: "answer", kind: "answer", inReplyTo: "q" }, sender);
  expect(similarOpen("room", question.body, inbox)).toBeUndefined();
  expect(similarOpen("other", question.body, inbox)).toBe("thread");
  inbox.dispose();
});
