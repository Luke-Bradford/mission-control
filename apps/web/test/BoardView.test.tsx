import type { BoardItem } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BoardView,
  type Choice,
  matchesView,
  parseView,
  VIEW_UNREADABLE_TEXT,
} from "../src/board/boardView.ts";
import { BoardPage } from "../src/pages/BoardPage.tsx";
import { BOARD_VIEW_KEY, LANE_KEY, readKey, tryWriteKey, writeKey } from "../src/storage.ts";
import { stubFetch } from "./fetchStub.ts";
import { boardItem, CONFIG, METRICS_VIEW, NOW, REPOS } from "./fixtures.ts";

const ANY: Choice = { kind: "any" };
const NONE: Choice = { kind: "none" };
const some = (...values: string[]): Choice => ({ kind: "some", values });
const view = (over: Partial<BoardView> = {}): BoardView => ({
  labels: ANY,
  labelMatch: "any",
  priority: ANY,
  assignee: ANY,
  milestone: ANY,
  ...over,
});
const card = (n: number, over: Partial<BoardItem> = {}) =>
  boardItem({ issueNumber: n, title: `Ticket ${n}`, status: "Todo", state: "planned", ...over });

describe("matchesView", () => {
  const bug = card(1, {
    labels: ["bug", "ui"],
    priority: "P1",
    assignees: ["Alice"],
    milestone: "v1",
  });
  const bare = card(2, { labels: [], priority: null, assignees: [], milestone: null });
  const noAssignees = card(3, { assignees: undefined });

  it("Any lets every card through", () => {
    for (const i of [bug, bare, noAssignees]) expect(matchesView(view(), i)).toBe(true);
  });

  it("None keeps only cards without the field", () => {
    for (const f of ["labels", "priority", "assignee", "milestone"] as const) {
      expect(matchesView(view({ [f]: NONE }), bare)).toBe(true);
      expect(matchesView(view({ [f]: NONE }), bug)).toBe(false);
    }
    expect(matchesView(view({ assignee: NONE }), noAssignees)).toBe(true);
  });

  it("Some keeps cards with one of the values; labels also match all", () => {
    expect(matchesView(view({ priority: some("P0", "P1") }), bug)).toBe(true);
    expect(matchesView(view({ priority: some("P0") }), bug)).toBe(false);
    expect(matchesView(view({ priority: some("P1") }), bare)).toBe(false);
    expect(matchesView(view({ milestone: some("v1") }), bug)).toBe(true);
    expect(matchesView(view({ milestone: some("v1") }), bare)).toBe(false);
    expect(matchesView(view({ labels: some("bug", "perf") }), bug)).toBe(true);
    expect(matchesView(view({ labels: some("bug", "perf"), labelMatch: "all" }), bug)).toBe(false);
    expect(matchesView(view({ labels: some("bug", "ui"), labelMatch: "all" }), bug)).toBe(true);
  });

  it("matches logins without regard to case", () => {
    expect(matchesView(view({ assignee: some("alice") }), bug)).toBe(true);
    expect(matchesView(view({ assignee: some("ALICE") }), bug)).toBe(true);
    expect(matchesView(view({ assignee: some("bob") }), bug)).toBe(false);
  });

  it("combines the four groups with AND", () => {
    const v = view({ priority: some("P1"), milestone: NONE });
    expect(matchesView(v, bug)).toBe(false);
    expect(matchesView(v, card(4, { priority: "P1", milestone: null }))).toBe(true);
  });
});

describe("parseView", () => {
  it("is null when nothing is saved", () => expect(parseView(null)).toBeNull());
  it("reads back what was saved", () => {
    const v = view({ labels: some("bug"), labelMatch: "all", assignee: NONE });
    expect(parseView(JSON.stringify(v))).toEqual(v);
  });
  it("calls bad JSON, a wrong shape and an empty some unreadable", () => {
    expect(parseView("{")).toBe("unreadable");
    expect(parseView("[]")).toBe("unreadable");
    expect(parseView(JSON.stringify({ ...view(), labelMatch: "most" }))).toBe("unreadable");
    expect(parseView(JSON.stringify({ ...view(), priority: { kind: "some", values: [1] } }))).toBe(
      "unreadable",
    );
    expect(parseView(JSON.stringify({ ...view(), priority: { kind: "some", values: [] } }))).toBe(
      "unreadable",
    );
    expect(parseView(JSON.stringify({ ...view(), milestone: { kind: "most" } }))).toBe(
      "unreadable",
    );
  });
});

describe("storage", () => {
  afterEach(() => vi.restoreAllMocks());
  it("tryWriteKey says whether storage took the value", () => {
    expect(tryWriteKey("k-test", "v")).toBe(true);
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(tryWriteKey("k-test", "v")).toBe(false);
  });
});

const items = [
  card(1, { labels: ["bug"], priority: "P0", assignees: ["Alice"], milestone: "v1" }),
  card(2, { labels: ["bug", "ui"], priority: "P1", assignees: ["bob"], milestone: "v2" }),
  card(3, { labels: [], priority: null, assignees: [], milestone: null }),
];

function stub(shop: BoardItem[] = items) {
  return stubFetch({
    "/api/repos": REPOS,
    "/api/config": CONFIG,
    "/api/boards/shop-app": shop,
    "/api/boards/site-builder": [],
    "/api/repos/shop-app/prs?linked=1&shape=summary": [],
    "/api/repos/site-builder/prs?linked=1&shape=summary": [],
    "/api/crew?shape=summary": { rows: [], firstRunToday: null },
    "/api/attention": [],
    "/api/metrics": METRICS_VIEW,
  });
}

const open = async () => {
  const r = render(<BoardPage repoId={null} ticket={null} />);
  await waitFor(() => expect(r.container.querySelector(".kcard, .kcol")).toBeTruthy());
  return r;
};
const shownTickets = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLElement>("[data-card]")].map((e) => e.dataset.card).sort();
const ALL3 = ["shop-app#1", "shop-app#2", "shop-app#3"];
const editor = () => screen.getByRole("form", { name: "Board view" });
const group = (name: string) => within(editor()).getByRole("group", { name });
const openEditor = () => fireEvent.click(screen.getByRole("button", { name: /^Board view/ }));
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save Board view" }));

beforeEach(() => {
  localStorage.clear();
  writeKey(LANE_KEY, "*");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Board view editor", () => {
  it("is closed until the toolbar button opens it, and offers the four groups", async () => {
    stub();
    await open();
    expect(screen.queryByRole("form", { name: "Board view" })).toBeNull();
    openEditor();
    expect(editor()).toBeTruthy();
    expect(screen.getByText("Saved in this browser")).toBeTruthy();
    for (const g of ["Labels", "Priority", "Assignee", "Milestone"]) {
      expect(within(group(g)).getByRole("radio", { name: "Any" })).toBeTruthy();
    }
    expect(within(group("Labels")).getByRole("radio", { name: "No labels" })).toBeTruthy();
    expect(within(group("Priority")).getByRole("radio", { name: "No priority" })).toBeTruthy();
    expect(within(group("Assignee")).getByRole("radio", { name: "Unassigned" })).toBeTruthy();
    expect(within(group("Milestone")).getByRole("radio", { name: "No milestone" })).toBeTruthy();
    expect(within(group("Labels")).getByRole("checkbox", { name: "ui" })).toBeTruthy();
    expect(within(group("Assignee")).getByRole("checkbox", { name: "Alice" })).toBeTruthy();
  });

  it("filters by a chosen value, and saves it in this browser", async () => {
    stub();
    const { container } = await open();
    openEditor();
    fireEvent.click(within(group("Priority")).getByRole("checkbox", { name: "P0" }));
    save();
    await waitFor(() => expect(shownTickets(container)).toEqual(["shop-app#1"]));
    expect(parseView(readKey(BOARD_VIEW_KEY))).toEqual(view({ priority: some("P0") }));
    expect(screen.queryByRole("form", { name: "Board view" })).toBeNull();
  });

  it("filters by None, and by labels matching all", async () => {
    stub();
    const { container } = await open();
    openEditor();
    fireEvent.click(within(group("Milestone")).getByRole("radio", { name: "No milestone" }));
    save();
    await waitFor(() => expect(shownTickets(container)).toEqual(["shop-app#3"]));
    openEditor();
    fireEvent.click(within(group("Milestone")).getByRole("radio", { name: "Any" }));
    fireEvent.click(within(group("Labels")).getByRole("checkbox", { name: "bug" }));
    fireEvent.click(within(group("Labels")).getByRole("checkbox", { name: "ui" }));
    fireEvent.change(within(group("Labels")).getByRole("combobox", { name: "Match" }), {
      target: { value: "all" },
    });
    save();
    await waitFor(() => expect(shownTickets(container)).toEqual(["shop-app#2"]));
  });

  it("matches an assignee login whatever its case", async () => {
    stub();
    const { container } = await open();
    openEditor();
    fireEvent.click(within(group("Assignee")).getByRole("checkbox", { name: "bob" }));
    save();
    await waitFor(() => expect(shownTickets(container)).toEqual(["shop-app#2"]));
  });

  it("reports an empty Some as a field error and keeps the form open", async () => {
    stub();
    const { container } = await open();
    openEditor();
    fireEvent.click(within(group("Labels")).getByRole("radio", { name: "Only these" }));
    save();
    const summary = await screen.findByRole("region", { name: "Fix before saving" });
    expect(within(summary).getByText(/at least one label/i)).toBeTruthy();
    expect(document.activeElement).toBe(summary);
    expect(
      within(group("Labels"))
        .getByRole("radio", { name: "Only these" })
        .getAttribute("aria-invalid"),
    ).toBe("true");
    expect(readKey(BOARD_VIEW_KEY)).toBeNull();
    expect(shownTickets(container)).toEqual(ALL3);
  });

  it("Cancel discards the draft and keeps the applied view", async () => {
    stub();
    const { container } = await open();
    openEditor();
    fireEvent.click(within(group("Priority")).getByRole("checkbox", { name: "P0" }));
    save();
    await waitFor(() => expect(shownTickets(container)).toEqual(["shop-app#1"]));
    openEditor();
    fireEvent.click(within(group("Priority")).getByRole("radio", { name: "Any" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Board view" })).toBeNull();
    expect(shownTickets(container)).toEqual(["shop-app#1"]);
    openEditor();
    expect(within(group("Priority")).getByRole("checkbox", { name: "P0" })).toHaveProperty(
      "checked",
      true,
    );
  });

  it("keeps a saved value that no card has, marked as such", async () => {
    writeKey(BOARD_VIEW_KEY, JSON.stringify(view({ milestone: some("v9") })));
    stub();
    await open();
    openEditor();
    const box = within(group("Milestone")).getByRole("checkbox", { name: /v9/ });
    expect(box).toHaveProperty("checked", true);
    expect(within(group("Milestone")).getByText("not on any current card")).toBeTruthy();
  });

  it("names the view in the toolbar when one is active", async () => {
    writeKey(BOARD_VIEW_KEY, JSON.stringify(view({ priority: some("P0") })));
    stub();
    const { container } = await open();
    expect(shownTickets(container)).toEqual(["shop-app#1"]);
    expect(screen.getByText("Lane query; Board view not included")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Board view/ }).className).toContain("on");
  });
});

describe("storage failures", () => {
  it("an unreadable saved view shows all cards and says so", async () => {
    writeKey(BOARD_VIEW_KEY, "{not json");
    stub();
    const { container } = await open();
    expect(shownTickets(container)).toEqual(ALL3);
    expect(screen.getByText(VIEW_UNREADABLE_TEXT)).toBeTruthy();
    expect(VIEW_UNREADABLE_TEXT).toBe("The saved Board view could not be read. Showing all cards.");
  });

  it("blocked reads show all cards", async () => {
    stub();
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { container } = await open();
    expect(shownTickets(container)).toEqual(ALL3);
  });

  it("a refused write still applies the view and says it is not saved", async () => {
    stub();
    const { container } = await open();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    openEditor();
    fireEvent.click(within(group("Priority")).getByRole("checkbox", { name: "P0" }));
    save();
    await waitFor(() => expect(shownTickets(container)).toEqual(["shop-app#1"]));
    expect(
      screen.getByText(
        "Not saved: this browser refused storage. The view applies until you reload.",
      ),
    ).toBeTruthy();
  });
});

describe("saving a view", () => {
  it("makes no API call at all and writes nothing to GitHub", async () => {
    const fn = stub();
    const { container } = await open();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const before = fn.mock.calls.length;
    openEditor();
    fireEvent.click(within(group("Labels")).getByRole("checkbox", { name: "bug" }));
    save();
    await waitFor(() => expect(shownTickets(container)).toEqual(["shop-app#1", "shop-app#2"]));
    expect(fn.mock.calls.length).toBe(before);
    expect(fn.mock.calls.filter(([, init]) => (init?.method ?? "GET") !== "GET")).toEqual([]);
  });
});
