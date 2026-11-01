import type { ReviewCheckState } from "@mc/core";
import { MIN, NOW, seatRow } from "./fixtures.ts";
export const REVIEW_STATES: { check: ReviewCheckState; label: string }[] = [
  { check: { kind: "queued", position: 2 }, label: "Waiting for review · 2nd in queue" },
  {
    check: { kind: "checking", seat: "retro-cx", since: NOW - 12 * MIN },
    label: "RETRO-CX checking · 12 min",
  },
  { check: { kind: "sent" }, label: "Findings sent · developer fixing" },
  { check: { kind: "ready" }, label: "Ready to merge" },
  { check: { kind: "held", by: "CAPCOM" }, label: "Held · CAPCOM" },
];
export const REVIEWER = seatRow({
  id: "retro-cx",
  hudState: "idle",
  role: "RETRO",
  mode: "scratch",
  ticket: null,
  run: null,
  stateSince: NOW - 12 * MIN,
  reviewing: { prNumber: 1039, sha: "a".repeat(40), ref: "shop-app#1027" },
});
