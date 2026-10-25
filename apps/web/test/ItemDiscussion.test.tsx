import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ItemDiscussion as Discussion } from "@mc/core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ItemDiscussion } from "../src/comms/ItemDiscussion.tsx";
import { hub } from "../src/data.ts";
import { stubFetch as fetchRoutes } from "./fetchStub.ts";

function stubFetch(routes: Parameters<typeof fetchRoutes>[0]) {
  const pinned: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(routes)) {
    if (!path.startsWith("POST ") && value && typeof value === "object" && "id" in value)
      pinned[`${path}?id=${encodeURIComponent(String(value.id))}`] = value;
  }
  return fetchRoutes({ ...pinned, ...routes });
}

const path = (key: string) => `/api/attention/${key}/discussion`;
const thread = (key: string): Discussion => ({
  id: `thread-${key}`,
  itemKey: key,
  version: "v1",
  messages: [],
});
describe("persistent item discussion", () => {
  it("switches item keys, refreshes correlated replies and never posts to global chat", async () => {
    const a = thread("a");
    const b = thread("b");
    const fn = stubFetch({
      [path("a")]: a,
      [path("b")]: b,
      [`POST ${path("a")}`]: (init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        a.messages.push({
          id: body.messageId,
          itemKey: "a",
          correlationId: a.id,
          role: "operator",
          text: body.text,
          at: 1,
        });
        return { status: 200, body: a };
      },
    });
    const view = render(<ItemDiscussion itemKey="a" live />);
    await screen.findByText("No messages yet.");
    fireEvent.change(screen.getByLabelText("Ask FLIGHT about this"), {
      target: { value: "Why per customer?" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Ask FLIGHT" }).closest("form") as HTMLFormElement,
    );
    await screen.findByText("Why per customer?");
    view.rerender(<ItemDiscussion itemKey="b" live />);
    await screen.findByText("No messages yet.");
    expect(screen.queryByText("Why per customer?")).toBeNull();
    a.messages.push({
      id: "reply",
      replyTo: a.messages[0]?.id,
      itemKey: "a",
      correlationId: a.id,
      role: "flight",
      text: "The rules are keyed by customer.",
      at: 2,
    });
    view.rerender(<ItemDiscussion itemKey="a" live />);
    act(() => hub.refetchTopic("attention"));
    await screen.findByText("The rules are keyed by customer.");
    view.unmount();
    render(<ItemDiscussion itemKey="a" live />);
    await screen.findByText("Why per customer?");
    expect(fn.mock.calls.filter(([, init]) => init?.method === "POST").map(([p]) => p)).toEqual([
      path("a"),
    ]);
    expect(document.querySelector("#dock")).toBeNull();
  });
  it("retains the question and stable message id on failure for retry", async () => {
    const bodies: unknown[] = [];
    stubFetch({
      [path("a")]: thread("a"),
      [`POST ${path("a")}`]: (init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return { status: 503, body: { error: "FLIGHT unavailable" } };
      },
    });
    render(<ItemDiscussion itemKey="a" live />);
    await screen.findByText("No messages yet.");
    const input = screen.getByLabelText("Ask FLIGHT about this") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "What changed?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask FLIGHT" }));
    await screen.findByRole("alert");
    expect(input.value).toBe("What changed?");
    fireEvent.click(screen.getByRole("button", { name: "Ask FLIGHT" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[0]).toEqual(bodies[1]);
  });
  it("shows a failed history load and permits refresh", async () => {
    stubFetch({ [path("a")]: () => ({ status: 503, body: { error: "History unavailable" } }) });
    render(<ItemDiscussion itemKey="a" live />);
    expect(screen.getByText("Loading discussion…")).toBeTruthy();
    await screen.findByText("History unavailable");
    expect((screen.getByRole("button", { name: "Ask FLIGHT" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Refresh discussion" })).toBeTruthy();
  });
});

// jsdom has no layout engine; check the responsive constraints in the real stylesheet.

it("keeps the fly-out and composer within a narrow screen", () => {
  const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
  expect(css.match(/\.flyout \{([^}]*)\}/)?.[1]).toContain("width: min(540px, 100%)");
  expect(css.match(/#discuss \.panel \{([^}]*)\}/)?.[1]).toContain("max-height: 86vh");
  expect(css.match(/#dsDiscussionForm \{([^}]*)\}/)?.[1]).toContain("flex-wrap: wrap");
  expect(css.match(/#dsDiscussionForm input \{([^}]*)\}/)?.[1]).toContain("min-width: 0");
  expect(css.match(/#discuss \.item-body \{([^}]*)\}/)?.[1]).toContain("overflow: auto");
  expect(css.match(/#discuss \.item-body \{([^}]*)\}/)?.[1]).toContain("overflow-anchor: none");
  expect(css.match(/#discuss \.expandable.open \.expandable-content \{([^}]*)\}/)?.[1]).toContain(
    "max-height: none",
  );
});

it("focuses and scrolls once per item, preserving focus and folds through refresh and reconnect", async () => {
  stubFetch({ [path("a")]: thread("a"), [path("b")]: thread("b") });
  const scroll = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    const view = render(<ItemDiscussion itemKey="a" live focus />);
    const input = screen.getByLabelText("Ask FLIGHT about this");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
    view.rerender(<ItemDiscussion itemKey="a" live collapsed />);
    const details = screen.getByText("Conversation with FLIGHT").closest("details");
    expect(details?.open).toBe(true);
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByText("Conversation with FLIGHT"));
    expect(details?.open).toBe(false);
    const summary = screen.getByText("Conversation with FLIGHT");
    summary.focus();
    view.rerender(<ItemDiscussion itemKey="a" live={false} focus />);
    view.rerender(<ItemDiscussion itemKey="a" live focus />);
    await act(async () => {});
    expect(document.activeElement).toBe(summary);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(details?.open).toBe(false);
    view.rerender(<ItemDiscussion itemKey="b" live focus />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Ask FLIGHT about this")),
    );
    expect(screen.getByText("Conversation with FLIGHT").closest("details")?.open).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(2);
  } finally {
    HTMLElement.prototype.scrollIntoView = original;
  }
});

it("labels message and receipt folds", async () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
  const discussion = thread("a");
  discussion.messages.push({
    id: "m",
    itemKey: "a",
    correlationId: discussion.id,
    role: "flight",
    text: "Long reply",
    at: 1,
  });
  discussion.messages.push({
    id: "m2",
    itemKey: "a",
    correlationId: discussion.id,
    role: "flight",
    text: "Another reply",
    at: 2,
  });
  stubFetch({ [path("a")]: discussion });
  render(<ItemDiscussion itemKey="a" live receipt={{ id: "receipt", text: "Long answer" }} />);
  expect(await screen.findByRole("button", { name: "Show more, FLIGHT’s message 1" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show more, FLIGHT’s message 2" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show more, Your answer" })).toBeTruthy();
  vi.restoreAllMocks();
});

it("does not take focus when FLIGHT comes online after mounting offline", async () => {
  stubFetch({ [path("a")]: thread("a") });
  const view = render(<ItemDiscussion itemKey="a" live={false} focus />);
  await screen.findByText("No messages yet.");
  const elsewhere = screen.getByRole("button", { name: "Refresh discussion" });
  elsewhere.focus();
  view.rerender(<ItemDiscussion itemKey="a" live focus />);
  await act(async () => {});
  expect(document.activeElement).toBe(elsewhere);
});

it("focuses once when the live seat finishes loading", async () => {
  stubFetch({ [path("a")]: thread("a") });
  const view = render(<ItemDiscussion itemKey="a" live={undefined} focus />);
  await screen.findByText("No messages yet.");
  view.rerender(<ItemDiscussion itemKey="a" live focus />);
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByLabelText("Ask FLIGHT about this")),
  );
});
