import { NOW } from "./fixtures.ts";

export const proposalTickets = [
  { number: 3349, title: "Quote cache", status: "In progress", count: 50 },
  { number: 3350, title: "Keep the cache warm after a restart", status: "In review", count: 18 },
  { number: 3351, title: "Explain a refused action beside its button", status: "Ready", count: 9 },
  { number: 3352, title: "Show the last successful refresh", status: "Done", count: 6 },
];
const words = [
  "Please compare the cache results before merging.",
  "The check is recorded. The request clears when the PR merges; no reply is needed.",
  "The decision is on Needs you. This thread keeps the conversation around it.",
  "The cache handoff is ready, including the eviction evidence and the next step.",
  "The PR merged. Its request for a check is now closed.",
];
export const proposalMessages = Array.from({ length: 50 }, (_, i) => ({
  id: `comms:${100 + i}`,
  at: NOW - (50 - i) * 60000,
  from: ["CAPCOM", "CONTROLLER", "flight-1", "guido-1", "MC"][i % 5],
  to: "crew",
  senderKind: ["operator", "controller", "flight", "seat", "hub"][i % 5],
  text: words[i % 5], ticket: "shop-app#3349", label: i % 5 === 3 ? "handoff" : null,
  ref: "#3349", replyTo: null, mentions: [], reactions: [], pinned: false, operator: i % 5 === 0,
}));
export const proposalEvents = [
  { id: "e1", at: "11:59", kind: "Notice", who: "HUB", text: "The PR merged. Its request for a check is closed.", detail: "No reply is needed; this remains part of the record." },
  { id: "e2", at: "11:54", kind: "Answer", who: "YOU", text: "Keep the shorter expiry and include the comparison in the handoff.", detail: "Answers GUIDO-1’s question: which expiry should the cache use?" },
  { id: "e3", at: "11:49", kind: "Question", who: "GUIDO-1", text: "Which expiry should the cache use?", detail: "Answered by you at 11:54. The question and its answer stay together." },
  { id: "e4", at: "11:42", kind: "Not now", who: "YOU", text: "Wait for the comparison before deciding the next rollout.", detail: "Set aside while the measurements arrive; this is not an unread message." },
  { id: "e5", at: "11:36", kind: "Handoff", who: "INCO-1 → GUIDO-1", text: "The interface is ready for the cache response.", detail: "Next: connect the response and retain the empty and refusal states." },
  { id: "e6", at: "11:31", kind: "Message", who: "CONTROLLER → FLIGHT", text: "The existing branch has passed its checks.", detail: "Addressed to the controller’s conversation; it does not notify the operator." },
  ...Array.from({ length: 24 }, (_, i) => ({ id: `older-${i}`, at: `10:${String(59 - i).padStart(2, "0")}`, kind: "Message", who: i % 2 ? "FLIGHT" : "GUIDO-1", text: i % 2 ? "The next step and its owner are recorded on this ticket." : "The cache comparison is attached to the existing handoff.", detail: "Earlier conversation retained for context." })),
];

export const proposalWaiting = [
  { seat: "GUIDO-1", age: "14 min", text: "FLIGHT asked for the eviction comparison.", agent: "guido-1", contact: "flight-1" },
  { seat: "GUIDO-2", age: "6 min", text: "GUIDO-1 is waiting for the empty-state check.", agent: "guido-2", contact: "guido-1" },
];
