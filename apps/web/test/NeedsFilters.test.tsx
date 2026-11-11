import { type AttentionItem, DEFAULT_AWAY } from "@mc/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { Needs } from "../src/pages/Needs.tsx";
import { stubFetch } from "./fetchStub.ts";
import { brief, CONFIG, crewRow, HOUR, item, NOW } from "./fixtures.ts";

const ask = (key: string, over: Partial<AttentionItem> = {}) =>
  item({
    key,
    kind: "question",
    escalationId: null,
    text: `Question ${key}`,
    at: NOW - HOUR,
    brief: brief({ recommendedOptionId: "a", options: [{ id: "a", label: "A", answer: "A" }] }),
    ...over,
  });

function mount(items: AttentionItem[]) {
  const discussions: Record<string, unknown> = {};
  for (const i of items) {
    const d = { id: `d:${i.key}`, itemKey: i.key, version: "v1", messages: [] };
    const p = `/api/attention/${encodeURIComponent(i.key)}/discussion`;
    discussions[p] = d;
    discussions[`${p}?id=${encodeURIComponent(d.id)}`] = d;
  }
  stubFetch({
    "/api/config": CONFIG,
    "/api/crew?shape=summary": { rows: [crewRow()], firstRunToday: null },
    "/api/attention": items,
    "/api/attention/held": [],
    "/api/notifications": { open: [], handledToday: [] },
    "/api/flight": { seat: null, decisions: [] },
    "/api/test-lock": { holder: null, waiting: [] },
    "/api/settings/away": DEFAULT_AWAY,
    "/api/machine": { latest: null },
    "/api/limits": [],
    ...discussions,
  });
  render(<Needs item={null} />);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  hub.clear();
});

const rowTexts = () =>
  [...document.querySelectorAll(".needs-row-text")].map((e) => e.textContent ?? "");

it("counts and lists only open questions; alerts and wake reminders stay out", async () => {
  mount([
    ask("q1", { text: "Port one" }),
    ask("q2", { text: "Port two" }),
    item({ key: "note:hub-update-held", kind: "approval", alert: true, text: "Update held" }),
    item({ key: "flight:wake:r1:3", kind: "message", owner: "flight", text: "Wake reminder" }),
    item({ key: "pr:x", kind: "pr", owner: "controller", text: "PR #3 · You: merge" }),
  ]);
  expect((await screen.findByTestId("question-count")).textContent).toBe("2 open questions");
  const group = screen.getByRole("region", { name: "Waiting on you" });
  expect(within(group).getAllByRole("link")).toHaveLength(2);
  expect(document.body.textContent).not.toContain("Wake reminder");
  expect(screen.getByTestId("alerts-chip").textContent).toBe("Alerts · 1");
});

it("shows no Alerts chip without an alert", async () => {
  mount([ask("q1")]);
  await screen.findByTestId("question-count");
  expect(screen.queryByTestId("alerts-chip")).toBeNull();
});

it("filters by text and repo, and orders newest first", async () => {
  mount([
    ask("q1", { text: "Port one", repoId: "shop-app", at: NOW - 3 * HOUR }),
    ask("q2", { text: "Colour two", repoId: "other", at: NOW - HOUR }),
  ]);
  await screen.findByTestId("question-count");
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "colour" } });
  expect(rowTexts().join()).toContain("Colour two");
  expect(rowTexts().join()).not.toContain("Port one");
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "shop-app" } });
  expect(rowTexts().join()).not.toContain("Colour two");
  fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Order"), { target: { value: "newest" } });
  expect(rowTexts()[0]).toContain("Colour two");
});
