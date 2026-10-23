import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AttentionItem } from "@mc/core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ItemPanel } from "../src/shell/ItemPanel.tsx";
import { openItem } from "../src/shell/overlays.ts";
import { stubFetch } from "./fetchStub.ts";
import { item } from "./fixtures.ts";

const key = "person:123:1000";
const path = `/api/attention/${encodeURIComponent(key)}`;
function setup(kind: "github" | "teams" = "github", fail = false, empty = false) {
  const person: AttentionItem = item({
    key,
    kind: "person",
    escalationId: null,
    brief: {
      context: "Context",
      recommendation: "Recommendation",
      options: [],
      basis: "source",
      at: 1000,
      catchUp: {
        kind: "new",
        line: "A new question",
        story: ["Investigation started"],
        aware: ["Wait for review"],
      },
      person: {
        source: { kind, messageId: "123", revision: "v1" },
        history: [
          {
            source: { kind, messageId: "122", revision: "v1" },
            author: "Finch",
            at: 900,
            text: "<script>earlier</script>",
            url: "https://github.com/example/demo/issues/1",
          },
        ],
        assessment: ["Review is needed"],
        take: "Check the change.",
        decisionKey: "decision:1",
        related: [{ label: "Change 1" }],
        replies: [{ id: "r1", label: "Acknowledge", text: "I will review <change>." }],
      },
    },
  });
  if (empty && person.brief?.person) person.brief.person.replies = [];
  const fn = stubFetch({
    "/api/attention": [
      person,
      item({ key: "decision:1", text: "Related question", escalationId: null }),
    ],
    "/api/escalations": [],
    "/api/crew": { rows: [] },
    "/api/notifications": {
      open: [
        {
          key,
          author: "Finch",
          title: "Review",
          snippet: "Truncated preview",
          message: {
            source: { kind, messageId: "123", revision: "v1" },
            author: "Finch",
            at: 1000,
            text: "<img onerror=alert(1)>",
            url: "https://github.com/example/demo/issues/1#issuecomment-123",
          },
          url: "https://github.com/example/demo/issues/1",
          repoId: "demo",
          number: 1,
          catchUp: "new",
          firstSeenAt: 1000,
          updatedAt: 1000,
        },
      ],
      handledToday: [],
    },
    [`POST ${path}/replies/r1/post`]: fail
      ? () => ({ status: 409, body: { error: "Source changed; refresh the item before posting." } })
      : { ok: true },
    [`POST ${path}/handled`]: { handled: key, message: "I will check before anything is sent." },
  });
  render(<ItemPanel />);
  act(() => openItem(key));
  return fn;
}
it("shows the story, escaped history/message, assessment, references and related decision", async () => {
  setup();
  await screen.findByText("Earlier in the thread");
  for (const text of [
    "So far",
    "Be aware",
    "Investigation started",
    "Review is needed",
    "Change 1",
    "<script>earlier</script>",
    "<img onerror=alert(1)>",
    "FLIGHT suggests",
  ])
    expect(screen.getByText(text)).toBeTruthy();
  expect(document.querySelector("#dsBrief script, #dsBrief img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open the related decision" }));
  await screen.findByText("Related question");
});
it("posts only on explicit approval, once, and retains the result", async () => {
  const fn = setup();
  const post = await screen.findByRole("button", { name: "Post on GitHub" });
  expect(fn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  fireEvent.click(post);
  fireEvent.click(post);
  await screen.findByText("replied on GitHub");
  expect(fn.mock.calls.filter(([p]) => p === `${path}/replies/r1/post`)).toHaveLength(1);
});
it("edits without sending and displays stale-source refusal", async () => {
  const fn = setup("github", true);
  fireEvent.click(await screen.findByRole("button", { name: "Edit first" }));
  const edit = screen.getByRole("textbox", { name: "Suggested reply" });
  fireEvent.change(edit, { target: { value: "Edited reply" } });
  expect(fn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Post on GitHub" }));
  await screen.findByText("Source changed; refresh the item before posting.");
});
it.each([true, false])(
  "copies Teams with clipboard success=%s and selectable fallback",
  async (ok) => {
    const writeText = vi.fn(
      ok
        ? async () => {}
        : async () => {
            throw new Error("blocked");
          },
    );
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const fn = setup("teams");
    fireEvent.click(await screen.findByRole("button", { name: "Copy for Teams" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("I will review <change>."));
    if (ok) await screen.findByText("reply copied for Teams");
    else {
      expect(await screen.findByRole("textbox", { name: "Suggested reply" })).toBeTruthy();
      expect(fn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    }
  },
);
it.each(["Mark handled", "Let FLIGHT handle it"])(
  "retains %s without posting a reply",
  async (name) => {
    const fn = setup();
    fireEvent.click(await screen.findByRole("button", { name }));
    await screen.findByText(name === "Mark handled" ? "marked handled" : "with FLIGHT");
    expect(fn.mock.calls.some(([p]) => p.includes("/replies/"))).toBe(false);
  },
);

it("shows an empty reply state and keeps keyboard focus in the panel", async () => {
  setup("github", false, true);
  await screen.findByText("No suggested replies yet.");
  const last = screen.getByRole("button", { name: "Ask FLIGHT" });
  const first = screen.getByRole("link", { name: "Open in GitHub ↗" });
  first.focus();
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  // With FLIGHT unavailable, the final enabled control is the local handoff.
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Let FLIGHT handle it" }));
  expect(last.hasAttribute("disabled")).toBe(true);
});
it.each(["loading", "failed", "empty"])("shows a %s person source response", async (state) => {
  stubFetch({
    "/api/attention": [item({ key, kind: "person", escalationId: null })],
    "/api/escalations": [],
    "/api/crew": { rows: [] },
    "/api/notifications":
      state === "failed"
        ? () => ({ status: 502, body: { error: "Source unavailable" } })
        : { open: [], handledToday: [] },
  });
  if (state === "loading") {
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", (path: string, init?: RequestInit) =>
      path === "/api/notifications" ? new Promise(() => {}) : original(path, init),
    );
  }
  render(<ItemPanel />);
  act(() => openItem(key));
  await screen.findByText(
    state === "loading"
      ? "Loading the message…"
      : state === "failed"
        ? "Could not load the message: Source unavailable"
        : "This message is no longer open.",
  );
});

it("constrains the reply region and wraps long text on narrow screens", () => {
  const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
  expect(css).toMatch(/width: min\(540px, 100%\)/);
  expect(css).toMatch(/\.person-choices\s*\{[^}]*overflow: auto;[^}]*min-height: 0;/);
  expect(css).toMatch(/\.person-choices \.opt\s*\{[^}]*overflow-wrap: anywhere;/);
});
