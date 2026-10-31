import { describe, expect, it } from "vitest";
import {
  ordinal,
  type ReviewCheckRow,
  type ReviewCheckState,
  reviewCheckOf,
  reviewCheckPill,
} from "../src/review.ts";

const row = (over: Partial<ReviewCheckRow> = {}): ReviewCheckRow => ({
  state: "reported",
  blocking: 0,
  seatId: "RETRO-1",
  createdAt: 1000,
  startedAt: null,
  ...over,
});

describe("reviewCheckOf", () => {
  it("is null with no rows, only superseded rows, or a failed newest review", () => {
    expect(reviewCheckOf([], 0, null)).toBeNull();
    expect(reviewCheckOf([row({ state: "superseded" })], 0, null)).toBeNull();
    expect(reviewCheckOf([row(), row({ state: "failed" })], 0, null)).toEqual({
      kind: "queued",
      position: 1,
    });
  });
  it("queued waits one place behind those ahead; starting is already checking", () => {
    expect(reviewCheckOf([row({ state: "queued" })], 0, null)).toEqual({
      kind: "queued",
      position: 1,
    });
    expect(reviewCheckOf([row({ state: "queued" })], 2, null)).toMatchObject({ position: 3 });
    expect(reviewCheckOf([row({ state: "starting", startedAt: 7 })], 2, null)).toEqual({
      kind: "checking",
      seat: "RETRO-1",
      since: 7,
    });
  });
  it("a hold outranks ready and sent: controller check, UAT, merge hold, FLIGHT clearance, any park", () => {
    const base = {
      mergeHold: null,
      uat: null,
      awaitingFlight: null,
      controllerCheck: null,
      phase: "review" as const,
      parked: null,
    };
    expect(
      reviewCheckOf([row()], 0, {
        ...base,
        controllerCheck: { sha: "a", from: "review", pass: false },
      }),
    ).toEqual({ kind: "held", by: "operator" });
    expect(
      reviewCheckOf([row()], 0, {
        ...base,
        controllerCheck: { sha: "a", from: "review", pass: true },
      }),
    ).toEqual({ kind: "ready" });
    expect(reviewCheckOf([row()], 0, { ...base, awaitingFlight: "a" })).toEqual({
      kind: "held",
      by: "FLIGHT",
    });
    expect(
      reviewCheckOf([row()], 0, {
        ...base,
        phase: "parked",
        parked: { kind: "gate", reason: "x", ended: false },
      }),
    ).toEqual({ kind: "held", by: "hub" });
    expect(
      reviewCheckOf([row({ blocking: 1 })], 0, {
        ...base,
        phase: "parked",
        parked: { kind: "review", reason: "x", ended: false },
      }),
    ).toEqual({ kind: "held", by: "hub" });
    expect(reviewCheckOf([row({ blocking: 1 })], 0, base)).toEqual({ kind: "sent" });
    expect(
      reviewCheckOf([row({ state: "failed" })], 1, {
        ...base,
        phase: "parked",
        parked: { kind: "review-failed", reason: "x", ended: false },
      }),
    ).toEqual({ kind: "held", by: "hub" });
  });
  it("running is checking, since the start else the request", () => {
    expect(reviewCheckOf([row({ state: "running", startedAt: 5000 })], 0, null)).toEqual({
      kind: "checking",
      seat: "RETRO-1",
      since: 5000,
    });
    expect(reviewCheckOf([row({ state: "running" })], 0, null)).toMatchObject({ since: 1000 });
  });
  it("takes the newest row that is not superseded", () => {
    const rows = [row({ blocking: 2 }), row({ state: "running" }), row({ state: "superseded" })];
    expect(reviewCheckOf(rows, 0, null)?.kind).toBe("checking");
  });
  it("reported with blocking findings is sent", () => {
    expect(reviewCheckOf([row({ blocking: 1 })], 0, null)).toEqual({ kind: "sent" });
  });
  it("reported clean is ready, or held by the merge hold or an unaccepted UAT", () => {
    expect(reviewCheckOf([row()], 0, null)).toEqual({ kind: "ready" });
    const none = {
      mergeHold: null,
      uat: null,
      awaitingFlight: null,
      controllerCheck: null,
      phase: "review" as const,
      parked: null,
    };
    expect(reviewCheckOf([row()], 0, none)).toEqual({ kind: "ready" });
    const hold = { by: "FLIGHT" as const, reason: "x", at: 1 };
    expect(reviewCheckOf([row()], 0, { ...none, mergeHold: hold })).toEqual({
      kind: "held",
      by: "FLIGHT",
    });
    const uat = (accepted: boolean) => ({ sha: "a", from: "review" as const, accepted });
    expect(reviewCheckOf([row()], 0, { ...none, uat: uat(false) })).toEqual({
      kind: "held",
      by: "operator",
    });
    expect(reviewCheckOf([row()], 0, { ...none, uat: uat(true) })).toEqual({
      kind: "ready",
    });
  });
});

describe("reviewCheckPill", () => {
  const pill = (c: ReviewCheckState, now = 0) => reviewCheckPill(c, now);
  it("says each state in the same words", () => {
    expect(pill({ kind: "queued", position: 2 })).toEqual({
      label: "Waiting for review · 2nd in queue",
      tone: "plain",
    });
    expect(pill({ kind: "checking", seat: "retro-cx", since: 0 }, 12 * 60_000 + 59_000)).toEqual({
      label: "RETRO-CX checking · 12 min",
      tone: "warn",
    });
    expect(pill({ kind: "sent" })).toEqual({
      label: "Findings sent · developer fixing",
      tone: "crit",
    });
    expect(pill({ kind: "ready" })).toEqual({ label: "Ready to merge", tone: "ok" });
    expect(pill({ kind: "held", by: "CAPCOM" })).toEqual({ label: "Held · CAPCOM", tone: "warn" });
    expect(pill({ kind: "held", by: "operator" }).label).toBe("Held · operator");
  });
});

describe("ordinal", () => {
  it("handles 1st 2nd 3rd 4th 11th 12th 13th 21st 22nd 101st 111th", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "101st",
      "111th",
    ]);
  });
});
