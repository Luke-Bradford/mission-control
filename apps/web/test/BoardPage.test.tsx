import type { BoardItem, PrCheck, PullRequestView, RepoProfile } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardRenderProbe } from "../src/board/Card.tsx";
import {
  NO_PR_YET,
  NO_REVIEWER,
  NOT_QUEUED,
  type QueueRow,
  ticketRef,
} from "../src/board/cards.ts";
import { Kanban } from "../src/board/Kanban.tsx";
import { hub } from "../src/data.ts";
import { BoardPage } from "../src/pages/BoardPage.tsx";
import { closeTopOverlay } from "../src/shell/overlays.ts";
import { setSession } from "../src/shell/session.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { settled, stubFetch } from "./fetchStub.ts";
import { boardItem, CONFIG, crewRow, HOUR, item, NOW, REPOS } from "./fixtures.ts";

const DAY = 86_400_000;
const GH = "https://github.com/octo-org/shop-app";

function pr(over: Partial<PullRequestView> = {}): PullRequestView {
  return {
    repoId: "shop-app",
    number: 40,
    title: "cache it",
    url: `${GH}/pull/40`,
    branch: "fix/3349-cache",
    ticket: "shop-app#3349",
    state: "open",
    isDraft: false,
    review: null,
    ci: null,
    createdAt: NOW - DAY,
    updatedAt: NOW - 1000,
    mergedAt: null,
    headSha: null,
    mergeable: null,
    ...over,
  };
}

const todo = (n: number, over: Partial<BoardItem> = {}) =>
  boardItem({ issueNumber: n, title: `Ticket ${n}`, status: "Todo", state: "planned", ...over });

interface Data {
  shopApp?: BoardItem[];
  engine?: BoardItem[];
  prs?: PullRequestView[];
  crew?: ReturnType<typeof crewRow>[];
  attention?: ReturnType<typeof item>[];
  profiles?: RepoProfile[] | (() => { status: number; body: unknown });
}

function stub(d: Data = {}) {
  return stubFetch({
    "/api/repos": REPOS,
    "/api/config": CONFIG,
    "/api/boards/shop-app": d.shopApp ?? [],
    "/api/boards/site-builder": d.engine ?? [],
    "/api/repos/shop-app/prs?linked=1": d.prs ?? [],
    "/api/repos/site-builder/prs?linked=1": [],
    "/api/crew": { rows: d.crew ?? [], firstRunToday: null },
    "/api/attention": d.attention ?? [],
    ...(d.profiles ? { "/api/repos/profiles": d.profiles } : {}),
    "/api/boards/site-builder/items/2": {
      number: 2,
      title: "Ticket 2",
      url: `${GH.replace("shop-app", "site-builder")}/issues/2`,
      state: "open",
      body: "the body",
      bodyTruncated: false,
      labels: [],
      milestone: null,
      subIssues: [],
      pullRequests: [],
    },
    "/api/boards/shop-app/items/3349": {
      number: 3349,
      title: "Ticket 3349",
      url: `${GH}/issues/3349`,
      state: "open",
      body: "the body",
      bodyTruncated: false,
      labels: [],
      milestone: null,
      subIssues: [],
      pullRequests: [],
    },
  });
}

const open = async (props: { repoId?: string | null; ticket?: number | null } = {}) => {
  const view = render(<BoardPage repoId={props.repoId ?? null} ticket={props.ticket ?? null} />);
  await waitFor(() => expect(view.container.querySelector(".kcard, .kcol")).toBeTruthy());
  return view;
};
const card = (c: HTMLElement, ref: string) => c.querySelector<HTMLElement>(`[data-card="${ref}"]`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("at phone width", () => {
  /** `matchMedia` that records its change listeners; `resize` flips `matches` and tells them. */
  const listeners = new Set<() => void>();
  let matches = false;
  const phone = (on: boolean) => {
    matches = on;
    listeners.clear();
    vi.stubGlobal("matchMedia", (q: string) => ({
      get matches() {
        return matches;
      },
      media: q,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }));
  };
  const resize = (on: boolean) =>
    act(() => {
      matches = on;
      for (const fn of [...listeners]) fn();
    });
  const data = {
    shopApp: [
      todo(1, { status: "Ready", state: "planned" }),
      todo(2, { status: "In Progress", state: "in progress" }),
    ],
  };

  it("opens the first non-empty column only, and a header tap switches", async () => {
    phone(true);
    stub(data);
    const { container } = await open();
    await screen.findByText("Ticket 1");
    expect(screen.queryByText("Ticket 2")).toBeNull();
    const ready = screen.getByRole("button", { name: "Ready 1" });
    expect(ready.getAttribute("aria-expanded")).toBe("true");
    const progress = screen.getByRole("button", { name: "In progress 1" });
    expect(progress.getAttribute("aria-expanded")).toBe("false");
    // an empty column is a header with its count and nothing to open
    expect(screen.queryByRole("button", { name: "Backlog 0" })).toBeNull();
    expect(container.querySelector(".kcol.empty .kh")?.textContent).toBe("Backlog 0");

    fireEvent.click(progress);
    expect(await screen.findByText("Ticket 2")).toBeTruthy();
    expect(screen.queryByText("Ticket 1")).toBeNull();
    expect(progress.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps every column's cards open on a wide screen", async () => {
    phone(false);
    stub(data);
    await open();
    expect(await screen.findByText("Ticket 1")).toBeTruthy();
    expect(screen.getByText("Ticket 2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ready 1" })).toBeNull();
  });

  it("each header controls its own panel", async () => {
    phone(true);
    stub(data);
    await open();
    await screen.findByText("Ticket 1");
    const ready = screen.getByRole("button", { name: "Ready 1" });
    const progress = screen.getByRole("button", { name: "In progress 1" });
    const panel = document.getElementById(ready.getAttribute("aria-controls") ?? "");
    expect(panel?.className).toBe("kb");
    expect(panel?.textContent).toContain("Ticket 1");
    expect(progress.getAttribute("aria-controls")).not.toBe(ready.getAttribute("aria-controls"));
  });

  it("follows the window across the breakpoint, both ways", async () => {
    phone(true);
    stub(data);
    await open();
    await screen.findByText("Ticket 1");
    expect(screen.queryByText("Ticket 2")).toBeNull();
    resize(false);
    expect(screen.getByText("Ticket 2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ready 1" })).toBeNull();
    resize(true);
    expect(screen.queryByText("Ticket 2")).toBeNull();
    expect(screen.getByRole("button", { name: "Ready 1" })).toBeTruthy();
  });

  it("stops listening when the board unmounts", async () => {
    phone(true);
    stub(data);
    const { unmount } = await open();
    await screen.findByText("Ticket 1");
    expect(listeners.size).toBeGreaterThan(0);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it("a picked column that empties is forgotten: a refill does not reopen it", () => {
    phone(true);
    const props = {
      showRepo: false,
      prs: [],
      crew: [],
      attention: [],
      unackedAttention: [],
      now: NOW,
      tz: "UTC",
      todayStart: 0,
    };
    const ready = todo(1, { status: "Ready", state: "planned" });
    const progress = todo(2, { status: "In Progress", state: "in progress" });
    const { rerender } = render(<Kanban items={[ready, progress]} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "In progress 1" }));
    expect(screen.getByText("Ticket 2")).toBeTruthy();
    rerender(<Kanban items={[ready]} {...props} />);
    expect(screen.getByText("Ticket 1")).toBeTruthy();
    rerender(<Kanban items={[ready, progress]} {...props} />);
    expect(screen.getByText("Ticket 1")).toBeTruthy();
    expect(screen.queryByText("Ticket 2")).toBeNull();
  });
});

describe("columns", () => {
  it("shows the eight Status columns from both repos' statuses, with counts", async () => {
    stub({
      shopApp: [todo(1), todo(2, { status: "In Progress", state: "in progress" })],
      engine: [
        todo(3, { repoId: "site-builder", status: "Ready for QA", state: "review" }),
        todo(4, { repoId: "site-builder", status: "Backlog", state: "planned" }),
      ],
    });
    const { container } = await open();
    await screen.findByText("Ticket 3");
    const heads = [...container.querySelectorAll(".kcol .kh")].map((h) => h.textContent);
    expect(heads).toEqual([
      "Backlog 1",
      "Refinement 0",
      "Blocked 0",
      "Ready 1",
      "In progress 1",
      "In review 0",
      "Ready for QA 1",
      "Done 0",
    ]);
  });

  it("an empty column is collapsed with a tooltip", async () => {
    stub({ shopApp: [todo(1)] });
    const { container } = await open();
    await screen.findByText("Ticket 1");
    const empty = container.querySelector(".kcol.empty") as HTMLElement;
    expect(empty.title).toBe("Backlog: nothing here");
    expect(container.querySelectorAll(".kcol.empty").length).toBe(7);
  });

  it("sorts by priority, P0 first and none last", async () => {
    stub({
      shopApp: [
        todo(1, { priority: null }),
        todo(2, { priority: "P2" }),
        todo(3, { priority: "P0" }),
        todo(4, { priority: "P1" }),
      ],
    });
    const { container } = await open();
    await screen.findByText("Ticket 1");
    const col = container.querySelector(".kcol:not(.empty)") as HTMLElement;
    expect([...col.querySelectorAll(".ktitle")].map((t) => t.textContent)).toEqual([
      "Ticket 3",
      "Ticket 4",
      "Ticket 2",
      "Ticket 1",
    ]);
  });
});

describe("cards", () => {
  it("shows #n in a repo lane and repo#n in All repos; null size shows nothing", async () => {
    stub({
      shopApp: [todo(1, { size: "M", milestone: "MVP — launch", labels: ["a", "b", "c", "d"] })],
    });
    const { container } = await open();
    await screen.findByText("Ticket 1");
    const c = card(container, "shop-app#1") as HTMLElement;
    expect(c.querySelector(".rchip")?.textContent).toBe("shop-app");
    expect(within(c).getByText("#1")).toBeTruthy();
    expect(within(c).getByText("M")).toBeTruthy();
    const ms = within(c).getByText("MVP");
    expect(ms.title).toBe("MVP — launch");
    expect(c.querySelectorAll(".lb").length).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "shop-app" }));
    const lane = card(container, "shop-app#1") as HTMLElement;
    expect(within(lane).getByText("#1")).toBeTruthy();
    expect(lane.querySelector(".rchip")).toBeNull();
  });

  it("a card's issue number links to GitHub and does not also open the card", async () => {
    stub({ shopApp: [todo(1)] });
    const { container } = await open();
    await screen.findByText("Ticket 1");
    const link = within(card(container, "shop-app#1") as HTMLElement).getByRole("link", {
      name: "shop-app #1",
    });
    expect(link.getAttribute("href")).toBe("https://github.com/octo-org/shop-app/issues/1");
    const before = window.location.pathname;
    fireEvent.click(link);
    expect(window.location.pathname).toBe(before);
  });

  it("Space on the focused title link opens the card, as Enter does", async () => {
    stub({ shopApp: [todo(1)] });
    const { container } = await open();
    await screen.findByText("Ticket 1");
    const title = within(card(container, "shop-app#1") as HTMLElement).getByRole("link", {
      name: "Ticket 1",
    });
    const before = window.location.pathname;
    // other keys do nothing
    expect(fireEvent.keyDown(title, { key: "a" })).toBe(true);
    expect(window.location.pathname).toBe(before);
    // Space follows the link, and the page does not scroll
    expect(fireEvent.keyDown(title, { key: " " })).toBe(false);
    expect(window.location.pathname).toBe("/board/shop-app/1");
  });

  it("Space with a modifier, or held down, does nothing on the title link", async () => {
    stub({ shopApp: [todo(1)] });
    const { container } = await open();
    await screen.findByText("Ticket 1");
    const title = within(card(container, "shop-app#1") as HTMLElement).getByRole("link", {
      name: "Ticket 1",
    });
    const before = window.location.pathname;
    for (const mod of [
      { shiftKey: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { repeat: true },
    ]) {
      expect(fireEvent.keyDown(title, { key: " ", ...mod }), JSON.stringify(mod)).toBe(true);
      expect(window.location.pathname).toBe(before);
    }
  });

  it("a modified click on the title link is left to the browser", async () => {
    stub({ shopApp: [todo(1)] });
    const { container } = await open();
    await screen.findByText("Ticket 1");
    const title = within(card(container, "shop-app#1") as HTMLElement).getByRole("link", {
      name: "Ticket 1",
    });
    const before = window.location.pathname;
    // new tab (⌘/Ctrl) and new window (Shift): followLink does not navigate or cancel the click
    for (const mod of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
      expect(fireEvent.click(title, mod)).toBe(true); // not defaultPrevented
      expect(window.location.pathname).toBe(before);
    }
    // the card's own shortcut must not take it either
    expect(window.location.pathname).not.toBe("/board/shop-app/1");
    // a plain click does navigate in-app
    expect(fireEvent.click(title)).toBe(false);
    expect(window.location.pathname).toBe("/board/shop-app/1");
  });

  it("every link in a card other than the title sits in a .rref, which the CSS lifts above the cover", async () => {
    stub({
      shopApp: [
        todo(3349, {
          status: "In progress",
          state: "in progress",
          blockedBy: [{ ref: "shop-app#2", closed: false }],
        }),
        todo(7, { status: "Done", state: "done" }),
      ],
      prs: [pr({ number: 40 }), pr({ number: 41, ticket: "shop-app#7", state: "merged" })],
      crew: [crewRow()],
    });
    const { container } = await open();
    await screen.findByText("Ticket 3349");
    for (const ref of ["shop-app#3349", "shop-app#7"]) {
      const links = [...(card(container, ref) as HTMLElement).querySelectorAll("a")];
      const others = links.filter((a) => !a.classList.contains("ktitle"));
      expect(others.length, ref).toBeGreaterThanOrEqual(2);
      for (const a of others) expect(a.closest(".rref"), `${ref} ${a.textContent}`).not.toBeNull();
    }
    // the worked card has its ref, its PR and its blocker as links
    expect(
      [...(card(container, "shop-app#3349") as HTMLElement).querySelectorAll(".rref a")].map((a) =>
        a.getAttribute("aria-label"),
      ),
    ).toEqual(["shop-app #3349", "shop-app PR #40", "shop-app #2"]);
  });

  it("a card is not a button around links: its title is the link that opens it", async () => {
    stub({
      shopApp: [todo(1), todo(3349, { status: "In progress", state: "in progress" })],
      crew: [crewRow()],
    });
    const { container } = await open();
    await screen.findByText("Ticket 1");
    const idle = card(container, "shop-app#1") as HTMLElement;
    expect(idle.getAttribute("role")).toBeNull();
    expect(idle.hasAttribute("tabindex")).toBe(false);
    // the ref link and the title link are both reachable by role
    const open1 = within(idle).getByRole("link", { name: "Ticket 1" });
    expect(open1.getAttribute("href")).toBe("/board/shop-app/1");
    fireEvent.click(open1);
    expect(window.location.pathname).toBe("/board/shop-app/1");
    // a worked card opens its agent
    const worked = card(container, "shop-app#3349") as HTMLElement;
    expect(within(worked).getByRole("link", { name: "Ticket 3349" }).getAttribute("href")).toBe(
      "/agent/shop-app-ta",
    );
  });

  it("a Ready card with no agent says it is not queued", async () => {
    stub({ shopApp: [todo(1)] });
    const { container } = await open();
    await screen.findByText("Ticket 1");
    expect(within(card(container, "shop-app#1") as HTMLElement).getByText(NOT_QUEUED)).toBeTruthy();
  });

  it("a queued Ready card says which seat takes it and its place", async () => {
    const guido: QueueRow = {
      ...crewRow({ id: "GUIDO-1", index: 2, kind: "crew", run: null, ticket: null }),
      queue: [{ ref: ticketRef(todo(1)), issue: 1, pos: 2 }],
    };
    stub({ shopApp: [todo(1)], crew: [guido] });
    const { container } = await open();
    await screen.findByText("Ticket 1");
    const c = card(container, "shop-app#1") as HTMLElement;
    expect(within(c).getByText("Next for")).toBeTruthy();
    expect(within(c).getByText("GUIDO-1")).toBeTruthy();
    expect(within(c).getByText(`· #${2} in its queue`)).toBeTruthy();
  });

  it("a card in review names its reviewer", async () => {
    const check = (name: string): PrCheck => ({
      name,
      kind: "check",
      state: name === "mc/review" ? "pending" : "passing",
      conclusion: "",
      attempt: null,
      url: null,
    });
    const retro = crewRow({
      id: "RETRO-1",
      index: 3,
      kind: "crew",
      run: null,
      ticket: null,
      reviewing: { prNumber: 40, sha: "c".repeat(40), ref: null },
    });
    stub({
      shopApp: [todo(3349, { status: "In review", state: "review" })],
      prs: [pr({ ci: "passing", checks: [check("check"), check("mc/review")] })],
      crew: [retro],
    });
    const { container } = await open();
    await screen.findByText("Ticket 3349");
    const c = card(container, "shop-app#3349") as HTMLElement;
    expect(within(c).getByText("Reviewing:")).toBeTruthy();
    expect(within(c).getByText("RETRO-1")).toBeTruthy();
    expect(within(c).getByText("check passing")).toBeTruthy();
    expect(within(c).queryByText(NO_REVIEWER)).toBeNull();
  });

  it("a card with none of these says so in words", async () => {
    stub({ shopApp: [todo(1), todo(2, { status: "In review", state: "review" })] });
    const { container } = await open();
    await screen.findByText("Ticket 1");
    const one = card(container, "shop-app#1") as HTMLElement;
    const two = card(container, "shop-app#2") as HTMLElement;
    expect(within(one).getByText("Unassigned · FLIGHT will offer it to an agent")).toBeTruthy();
    expect(within(two).getByText("No reviewer on it now")).toBeTruthy();
    expect(within(two).getByText(NO_PR_YET)).toBeTruthy();
    expect(one.textContent).not.toContain("—");
    expect(two.textContent).not.toContain("—");
  });

  it("PR line: CI pill from CI_PILL, no review pill on a plain open PR", async () => {
    stub({
      shopApp: [todo(3349, { status: "In review", state: "review" })],
      prs: [pr({ ci: "passing" })],
    });
    const { container } = await open();
    const c = (await screen.findByText("Ticket 3349")).closest(".kcard") as HTMLElement;
    const ov = c.querySelector(".overlay") as HTMLElement;
    expect(within(ov).getByText("PR #40")).toBeTruthy();
    expect(within(ov).getByText("CI passing").className).toBe("pill ok");
    expect(within(ov).queryByText("Open")).toBeNull();
    expect(container.querySelectorAll(".overlay .pill").length).toBe(1);
  });

  it("a PR with review state shows it; a draft shows Draft; failing CI is red", async () => {
    stub({
      shopApp: [todo(3349, { status: "In review", state: "review" })],
      prs: [pr({ ci: "failing", review: "changes" })],
    });
    await open();
    const c = (await screen.findByText("Ticket 3349")).closest(".kcard") as HTMLElement;
    expect(within(c).getByText("CI failing").className).toBe("pill crit");
    expect(within(c).getByText("Changes asked").className).toBe("pill crit");
  });

  it("null CI shows no CI pill", async () => {
    stub({
      shopApp: [todo(3349, { status: "In review", state: "review" })],
      prs: [pr({ isDraft: true, ci: null })],
    });
    await open();
    const c = (await screen.findByText("Ticket 3349")).closest(".kcard") as HTMLElement;
    expect(within(c).getByText("Draft")).toBeTruthy();
    expect(c.textContent).not.toMatch(/CI /);
  });

  it("a closed, unmerged PR keeps its Closed pill", async () => {
    stub({
      shopApp: [todo(3349, { status: "In review", state: "review" })],
      prs: [pr({ state: "closed" })],
    });
    await open();
    const c = (await screen.findByText("Ticket 3349")).closest(".kcard") as HTMLElement;
    expect(within(c).getByText("Closed").className).toBe("pill plain");
  });

  it("the card shows the code PR, not the spec PR on the same ticket", async () => {
    stub({
      shopApp: [todo(3349, { status: "In review", state: "review" })],
      prs: [pr({ number: 1, branch: "docs/3349-spec" }), pr({ number: 2 })],
    });
    await open();
    const c = (await screen.findByText("Ticket 3349")).closest(".kcard") as HTMLElement;
    expect(within(c).getByText("PR #2")).toBeTruthy();
    expect(within(c).queryByText("PR #1")).toBeNull();
  });

  it("a PR waiting on you shows the You pill and pulses the card", async () => {
    stub({
      shopApp: [todo(3349, { status: "In review", state: "review" })],
      prs: [pr({ isDraft: true, updatedAt: NOW - 9 * DAY })],
      attention: [
        item({
          key: `pr:shop-app#40:${NOW - 9 * DAY}`,
          kind: "pr",
          agentId: null,
          escalationId: null,
          ticket: "shop-app#3349",
        }),
      ],
    });
    await open();
    const c = (await screen.findByText("Ticket 3349")).closest(".kcard") as HTMLElement;
    expect(within(c).getByText("You: decide on the draft · waiting 9 days").className).toBe(
      "pill warn",
    );
    expect(c.className).toContain("pulse-warn");
  });

  it("a Done card has no PR line but its outcome and age; any merged PR makes it Merged", async () => {
    stub({
      shopApp: [todo(3349, { status: "Done", state: "done", updatedAt: NOW - 3 * DAY })],
      prs: [
        pr({ number: 1, state: "merged", branch: "docs/3349-spec", ci: "passing" }),
        pr({ number: 2, state: "closed" }),
      ],
    });
    await open();
    const c = (await screen.findByText("Ticket 3349")).closest(".kcard") as HTMLElement;
    expect(within(c).getByText("Merged").className).toBe("pill ok");
    expect(c.textContent).toContain("3d ago · PR #");
    expect(within(c).queryByText("CI passing")).toBeNull();
  });

  it("a Done card's age is — until the timezone is known", () => {
    render(
      <Kanban
        items={[todo(3349, { status: "Done", state: "done", updatedAt: NOW - 3 * DAY })]}
        showRepo={false}
        prs={[]}
        crew={[]}
        attention={[]}
        unackedAttention={[]}
        now={NOW}
        tz={null}
        todayStart={null}
      />,
    );
    const c = screen.getByText("Ticket 3349").closest(".kcard") as HTMLElement;
    expect(c.textContent).toContain("—");
    expect(c.textContent).not.toContain("ago");
    expect(c.textContent).not.toContain("today");
  });

  it("a closed issue whose Status says In progress sits in Done with the Status out of date flag", async () => {
    stub({
      shopApp: [
        todo(7, {
          status: "In progress",
          state: "in progress",
          closed: true,
          updatedAt: NOW - 2 * DAY,
          blockedBy: [{ ref: "shop-app#2", closed: false }],
        }),
        todo(8, { status: "In progress", state: "in progress" }),
      ],
    });
    const { container } = await open();
    await screen.findByText("Ticket 7");
    const c = card(container, "shop-app#7") as HTMLElement;
    expect((c.closest(".kcol") as HTMLElement).querySelector(".kh")?.textContent).toMatch(/^Done/);
    const flag = within(c).getByText("Status out of date");
    expect(flag.title).toBe("GitHub says Closed; the board's Status says In progress");
    expect(within(c).queryByText(/^Blocked:/)).toBeNull();
    // the open one agrees with its Status: no flag
    expect(
      within(card(container, "shop-app#8") as HTMLElement).queryByText("Status out of date"),
    ).toBeNull();
  });

  it("an open issue whose Status is Done stays in Done with the flag", async () => {
    stub({ shopApp: [todo(9, { status: "Done", state: "done", closed: false })] });
    const { container } = await open();
    await screen.findByText("Ticket 9");
    const c = card(container, "shop-app#9") as HTMLElement;
    expect(within(c).getByText("Status out of date").title).toBe(
      "GitHub says Open; the board's Status says Done",
    );
  });

  it("an issue with no Status lands in Backlog", async () => {
    stub({ shopApp: [todo(10, { status: "", state: "planned" })] });
    const { container } = await open();
    await screen.findByText("Ticket 10");
    const c = card(container, "shop-app#10") as HTMLElement;
    expect((c.closest(".kcol") as HTMLElement).querySelector(".kh")?.textContent).toMatch(
      /^Backlog/,
    );
    expect(within(c).queryByText("Status out of date")).toBeNull();
  });

  it("Blocked: the first open blocker", async () => {
    stub({
      shopApp: [
        todo(5, {
          status: "Blocked",
          state: "blocked",
          blockedBy: [
            { ref: "shop-app#1", closed: true },
            { ref: "shop-app#2", closed: false },
          ],
        }),
      ],
    });
    await open();
    const link = await screen.findByRole("link", { name: "shop-app #2" });
    expect(link.getAttribute("href")).toBe("https://github.com/octo-org/shop-app/issues/2");
    expect(link.closest(".warn-t")?.textContent).toMatch(/^Blocked: /);
  });

  it("Blocked: when every blocker is closed, the card shows none", async () => {
    stub({
      shopApp: [
        todo(5, {
          status: "Blocked",
          state: "blocked",
          blockedBy: [
            { ref: "shop-app#1", closed: true },
            { ref: "shop-app#2", closed: true },
          ],
        }),
      ],
    });
    const { container } = await open();
    await screen.findByText("Ticket 5");
    const c = card(container, "shop-app#5") as HTMLElement;
    expect(within(c).queryByText(/Blocked:/)).toBeNull();
    expect(within(c).queryByRole("link", { name: "shop-app #1" })).toBeNull();
    expect(within(c).queryByRole("link", { name: "shop-app #2" })).toBeNull();
  });

  it("a Ready ticket with an open blocker sits in Blocked and names it", async () => {
    stub({
      shopApp: [
        todo(6, {
          status: "Todo",
          state: "planned",
          blockedBy: [{ ref: "shop-app#2", closed: false }],
        }),
      ],
    });
    const { container } = await open();
    await screen.findByText("Ticket 6");
    const c = card(container, "shop-app#6") as HTMLElement;
    expect((c.closest(".kcol") as HTMLElement).querySelector(".kh")?.textContent).toMatch(
      /^Blocked/,
    );
    expect(within(c).getByRole("link", { name: "shop-app #2" })).toBeTruthy();
  });

  it("a Ready ticket whose blockers are closed stays in Ready", async () => {
    stub({
      shopApp: [
        todo(7, {
          status: "Todo",
          state: "planned",
          blockedBy: [{ ref: "shop-app#2", closed: true }],
        }),
      ],
    });
    const { container } = await open();
    await screen.findByText("Ticket 7");
    const c = card(container, "shop-app#7") as HTMLElement;
    expect((c.closest(".kcol") as HTMLElement).querySelector(".kh")?.textContent).toMatch(/^Ready/);
  });
});

describe("agent overlay and click", () => {
  const working = () => [todo(3349, { status: "In progress", state: "in progress" })];

  it("a worked card shows the agent tag, its state pill and run number; click goes to the agent", async () => {
    stub({ shopApp: working(), crew: [crewRow()] });
    await open();
    const c = (await screen.findByText("Ticket 3349")).closest(".kcard") as HTMLElement;
    expect(within(c).getByText("shop-app-ta")).toBeTruthy();
    expect(within(c).getByText("Running").className).toBe("pill ok");
    expect(within(c).getByText(`run #${crewRow().run?.seq} · no template step`)).toBeTruthy();
    expect(c.className).toContain("pulse-ok");
    expect(c.title).toBe("Being worked on or looked at now");
    fireEvent.click(c);
    expect(window.location.pathname).toBe("/agent/shop-app-ta");
  });

  it("a worked card shows its template, step and try", async () => {
    const loop = {
      phase: "working",
      text: "Working",
      prNumber: null,
      parked: null,
      profile: "feature",
      step: "implement",
      tries: { n: 1, max: 3 },
    } as const;
    stub({ shopApp: working(), crew: [crewRow({ loop })] });
    await open();
    const c = (await screen.findByText("Ticket 3349")).closest(".kcard") as HTMLElement;
    expect(within(c).getByText("feature › implement · try 1 of 3")).toBeTruthy();
    expect(within(c).queryByText(`run #${crewRow().run?.seq}`)).toBeNull();
  });

  it("a finished run never marks a card", async () => {
    const done = crewRow({ run: { ...(crewRow().run as object), status: "ok" } as never });
    stub({ shopApp: working(), crew: [done] });
    await open();
    const c = (await screen.findByText("Ticket 3349")).closest(".kcard") as HTMLElement;
    expect(within(c).queryByText("shop-app-ta")).toBeNull();
    expect(c.className).toBe("kcard");
  });

  it("the ticket detail opens beside the board with the agent on it", async () => {
    stub({ shopApp: working(), crew: [crewRow()] });
    await open({ repoId: "shop-app", ticket: 3349 });
    const pane = await screen.findByRole("complementary", { name: "ticket" });
    expect(await within(pane).findByRole("region", { name: "Agent on it" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Standup brief" })).toBeTruthy();
  });
});

describe("filters", () => {
  const board = [
    todo(1, { status: "Done", state: "done", updatedAt: NOW - 10 * DAY, title: "Old done" }),
    todo(2, { status: "Done", state: "done", updatedAt: NOW - 2 * DAY, title: "New done" }),
    todo(3349, { status: "In progress", state: "in progress", priority: "P1" }),
    todo(4, { priority: "P0", title: "Plain" }),
  ];

  it("Done 14d shows a 10-day-old item that 7d hides", async () => {
    stub({ shopApp: board });
    await open();
    await screen.findByText("New done");
    expect(screen.queryByText("Old done")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done 14d" }));
    expect(screen.getByText("Old done")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done 7d" }));
    expect(screen.queryByText("Old done")).toBeNull();
  });

  it("Priority lists the distinct priorities and filters", async () => {
    stub({ shopApp: board });
    await open();
    await screen.findByText("Plain");
    const sel = screen.getByLabelText("Priority") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["", "P0", "P1"]);
    fireEvent.change(sel, { target: { value: "P0" } });
    expect(screen.getByText("Plain")).toBeTruthy();
    expect(screen.queryByText("Ticket 3349")).toBeNull();
  });

  it("Has an agent keeps only cards with a running run", async () => {
    stub({ shopApp: board, crew: [crewRow()] });
    await open();
    await screen.findByText("Plain");
    fireEvent.click(screen.getByRole("button", { name: "Has an agent" }));
    expect(screen.queryByText("Plain")).toBeNull();
    expect(screen.getByText("Ticket 3349")).toBeTruthy();
  });

  it("Needs me keeps an escalated card and a worked card whose agent is stalled", async () => {
    stub({
      shopApp: board,
      crew: [crewRow({ hudState: "stalled" })],
      attention: [
        item({ key: "stall:r-12", kind: "stalled", escalationId: null, ticket: null }),
        item({ escalationId: "shop-app#4", ticket: "shop-app#4" }),
      ],
    });
    await open();
    await screen.findByText("Plain");
    const stalled = screen.getByText("Ticket 3349").closest(".kcard") as HTMLElement;
    expect(stalled.className).toContain("pulse-warn");
    expect(stalled.title).toBe("Needs you");
    fireEvent.click(screen.getByRole("button", { name: "Needs me" }));
    expect(screen.getByText("Plain")).toBeTruthy();
    expect(screen.getByText("Ticket 3349")).toBeTruthy();
    expect(screen.queryByText("New done")).toBeNull();
  });

  it("the session filter hides another session's assigned cards and keeps Done and unassigned cards", async () => {
    stub({
      shopApp: board,
      engine: [todo(7, { repoId: "site-builder", title: "Engine plain" })],
      crew: [crewRow()],
    });
    await open();
    await screen.findByText("Ticket 3349");
    act(() => setSession("site-builder"));
    expect(screen.queryByText("Ticket 3349")).toBeNull();
    expect(screen.getByText("New done")).toBeTruthy();
    expect(screen.getByText("Plain")).toBeTruthy();
    expect(screen.getByText("Engine plain")).toBeTruthy();
  });
});

describe("lanes", () => {
  it("shows the query for the lane and copies it", async () => {
    stub({ shopApp: [todo(1)] });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<Toast />);
    await open();
    const link = screen.queryByRole("link", { name: "Open in GitHub ↗" });
    expect(link).toBeNull(); // All repos has no project page
    expect(
      screen.getByText("repo:octo-org/shop-app repo:octo-org/site-builder is:issue"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "shop-app" }));
    expect(screen.getByRole("link", { name: "Open in GitHub ↗" }).getAttribute("href")).toBe(
      "https://github.com/users/octo-org/projects/2",
    );
    await act(async () => fireEvent.click(screen.getByTitle("Copy the GitHub query")));
    expect(writeText).toHaveBeenCalledWith("repo:octo-org/shop-app is:issue");
    expect(screen.getByRole("status").textContent).toBe("Query copied.");
  });

  it("a blocked clipboard gets the fallback toast", async () => {
    stub();
    vi.stubGlobal("navigator", {
      clipboard: { writeText: async () => Promise.reject(new Error("no")) },
    });
    render(<Toast />);
    await open();
    await act(async () => fireEvent.click(screen.getByTitle("Copy the GitHub query")));
    expect(screen.getByRole("status").textContent).toBe(
      "Copy was blocked here; select the query and copy it.",
    );
  });

  it("remembers the lane, and /board/:repo overrides and stores it", async () => {
    stub({ shopApp: [todo(1)], engine: [todo(2, { repoId: "site-builder" })] });
    const first = await open();
    fireEvent.click(screen.getByRole("button", { name: "site-builder" }));
    expect(localStorage.getItem("mc-lane")).toBe("site-builder");
    expect(window.location.pathname).toBe("/board/site-builder");
    first.unmount();
    // a fresh visit to /board uses the stored lane
    window.history.replaceState(null, "", "/board");
    await open();
    expect(screen.getByRole("button", { name: "site-builder" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("the route's repo selects its lane over the stored one", async () => {
    localStorage.setItem("mc-lane", "site-builder");
    stub({ shopApp: [todo(1)] });
    await open({ repoId: "shop-app" });
    expect(screen.getByRole("button", { name: "shop-app" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await waitFor(() => expect(localStorage.getItem("mc-lane")).toBe("shop-app"));
  });
});

describe("ticket route, lane and session", () => {
  afterEach(() => act(() => setSession("all")));

  it("a ticket route keeps the stored All repos lane and does not write mc-lane", async () => {
    localStorage.setItem("mc-lane", "*");
    stub({ shopApp: [todo(3349)], engine: [todo(2, { repoId: "site-builder" })] });
    await open({ repoId: "shop-app", ticket: 3349 });
    expect(screen.getByRole("button", { name: "All repos" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(localStorage.getItem("mc-lane")).toBe("*");
  });

  it("the split gets withdetail only while a ticket is open", async () => {
    stub({ shopApp: [todo(3349)] });
    const first = await open({ repoId: "shop-app", ticket: 3349 });
    expect(first.container.querySelector(".boardsplit")?.classList.contains("withdetail")).toBe(
      true,
    );
    first.unmount();
    const second = await open({ repoId: "shop-app" });
    expect(second.container.querySelector(".boardsplit")?.classList.contains("withdetail")).toBe(
      false,
    );
  });

  it("a session keeps unassigned cards in All repos and offers each repo lane", async () => {
    stub({
      shopApp: [todo(1, { title: "Mine" })],
      engine: [todo(2, { repoId: "site-builder", title: "Theirs" })],
    });
    act(() => setSession("shop-app"));
    await open();
    await screen.findByText("Mine");
    expect(screen.getByText("Theirs")).toBeTruthy();
    expect(screen.getByRole("button", { name: "All repos" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "site-builder" })).toBeTruthy();
  });

  it("a session preserves a route naming another repo's lane", async () => {
    stub({
      shopApp: [todo(1, { title: "Mine" })],
      engine: [todo(2, { repoId: "site-builder", title: "Theirs" })],
    });
    act(() => setSession("shop-app"));
    const { container } = await open({ repoId: "site-builder" });
    await screen.findByText("Theirs");
    expect(screen.queryByText("Mine")).toBeNull();
    expect(container.textContent).not.toContain("Showing s/");
    expect(localStorage.getItem("mc-lane")).toBe("site-builder");
  });

  it("a session preserves the stored lane and its unassigned cards", async () => {
    localStorage.setItem("mc-lane", "site-builder");
    stub({
      shopApp: [todo(1, { title: "Mine" })],
      engine: [todo(2, { repoId: "site-builder", title: "Theirs" })],
    });
    act(() => setSession("shop-app"));
    const { container } = await open();
    await screen.findByText("Theirs");
    expect(card(container, "site-builder#2")).toBeTruthy();
    expect(screen.queryByText("Mine")).toBeNull();
    expect(screen.getByRole("button", { name: "site-builder" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(container.textContent).not.toContain("Showing s/");
    expect(localStorage.getItem("mc-lane")).toBe("site-builder");
  });

  it("a session with a ticket deep link keeps the ticket and unassigned cards in view", async () => {
    stub({
      shopApp: [todo(1, { title: "Mine" })],
      engine: [todo(2, { repoId: "site-builder" })],
    });
    act(() => setSession("shop-app"));
    const { container } = await open({ repoId: "site-builder", ticket: 2 });
    const pane = await screen.findByRole("complementary", { name: "ticket" });
    expect(await within(pane).findByRole("heading", { name: "Ticket 2" })).toBeTruthy();
    expect(within(pane).getByRole("link", { name: "site-builder #2" })).toBeTruthy();
    expect(card(container, "shop-app#1")).toBeTruthy();
    expect(card(container, "site-builder#2")).toBeTruthy();
    expect(container.textContent).not.toContain("Showing s/");
    expect(localStorage.getItem("mc-lane")).toBeNull();
  });

  it("a session with a stored lane for a repo no longer configured shows no note", async () => {
    localStorage.setItem("mc-lane", "gone-repo");
    stub({ shopApp: [todo(1, { title: "Mine" })] });
    act(() => setSession("shop-app"));
    const { container } = await open();
    await screen.findByText("Mine");
    expect(container.textContent).not.toContain("Showing s/");
  });

  it("a session with a stored All repos lane shows no note", async () => {
    localStorage.setItem("mc-lane", "*");
    stub({ shopApp: [todo(1, { title: "Mine" })] });
    act(() => setSession("shop-app"));
    const { container } = await open();
    await screen.findByText("Mine");
    expect(container.textContent).not.toContain("Showing s/");
  });
});

describe("brief modal", () => {
  const board = [
    todo(1, { status: "Done", state: "done", updatedAt: NOW - 1000, title: "Shipped" }),
    todo(3349, { status: "In progress", state: "in progress" }),
  ];

  it("opens the standup, switches to the weekly update, copies, and Esc closes it", async () => {
    stub({
      shopApp: board,
      crew: [crewRow()],
      prs: [pr({ number: 9, ticket: "shop-app#1", state: "merged" })],
    });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<Toast />);
    await open();
    await screen.findByText("Shipped");
    fireEvent.click(screen.getByRole("button", { name: "Standup brief" }));
    const dialog = screen.getByRole("dialog", { name: "Brief" });
    const text = dialog.querySelector("pre") as HTMLElement;
    expect(text.textContent).toBe(
      [
        "Standup, Saturday 17 October (All repos)",
        "Since yesterday\n- shop-app#1 (PR #9): Shipped (merged)",
        "Today\n- shop-app#3349: Ticket 3349 (run #12)",
      ].join("\n\n"),
    );
    expect(text.textContent).not.toContain("shop-app-ta");
    fireEvent.click(within(dialog).getByRole("button", { name: "Weekly update" }));
    expect(text.textContent).toMatch(
      /^Update: All repos, last 7 days\n\nDone\n- shop-app#1 \(PR #9\): Shipped \(merged today\)/,
    );
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Copy" })));
    expect(writeText).toHaveBeenCalledWith(text.textContent);
    expect(screen.getByRole("status").textContent).toBe("Copied. Paste it into Teams or an email.");
    act(() => {
      closeTopOverlay();
    });
    expect(screen.queryByRole("dialog", { name: "Brief" })).toBeNull();
  });
});

describe("missing sources", () => {
  it("a board that fails says so and the other repo still shows", async () => {
    stubFetch({
      "/api/repos": REPOS,
      "/api/config": CONFIG,
      "/api/boards/site-builder": [todo(2, { repoId: "site-builder", title: "Still here" })],
      "/api/repos/shop-app/prs?linked=1": [],
      "/api/repos/site-builder/prs?linked=1": [],
      "/api/crew": { rows: [], firstRunToday: null },
      "/api/attention": [],
    });
    render(<BoardPage repoId={null} ticket={null} />);
    expect(await screen.findByText("Still here")).toBeTruthy();
    expect(await screen.findByText(/Could not load the board — shop-app/)).toBeTruthy();
  });

  it("no repos, no crew: an empty board, no crash", async () => {
    stubFetch({
      "/api/repos": [],
      "/api/config": CONFIG,
      "/api/crew": { rows: [], firstRunToday: null },
      "/api/attention": [],
    });
    const { container } = render(<BoardPage repoId={null} ticket={null} />);
    await waitFor(() => expect(container.querySelectorAll(".kcol.empty").length).toBe(8));
  });
});

// #26 A1: an idle Board re-rendered every card on each 5 s clock tick and each crew refetch.
describe("render cost", () => {
  const studio = (ticket: string) =>
    crewRow({ id: "studio-builder", index: 1, loopKind: "studio-loop", ticket });

  it("the 5 s clock re-renders no card; a crew change re-renders only the card it changes", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    const states = ["Todo", "In Progress", "In review", "Done"] as const;
    const board = Array.from({ length: 300 }, (_, i) => {
      const status = states[i % states.length] ?? "Todo";
      return todo(i + 1, {
        status,
        state: status === "Done" ? "done" : status === "Todo" ? "planned" : "in progress",
        updatedAt: NOW - (i % 5) * HOUR,
        priority: i % 3 === 0 ? "P1" : null,
      });
    });
    let crew = [crewRow({ ticket: "shop-app#2" }), studio("shop-app#6")];
    stubFetch({
      "/api/repos": REPOS,
      "/api/config": CONFIG,
      "/api/boards/shop-app": board,
      "/api/boards/site-builder": [],
      "/api/repos/shop-app/prs?linked=1": [pr({ number: 41, ticket: "shop-app#3" })],
      "/api/repos/site-builder/prs?linked=1": [],
      "/api/crew": () => ({ status: 200, body: { rows: crew, firstRunToday: null } }),
      "/api/attention": [],
    });
    const { container } = render(<BoardPage repoId={null} ticket={null} />);
    await waitFor(() => expect(container.querySelectorAll(".kcard").length).toBe(300));
    await screen.findByText("studio-builder");
    await screen.findByText("PR #41");

    const renders: string[] = [];
    cardRenderProbe.onRender = (ref) => renders.push(ref);
    try {
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(renders).toEqual([]);

      // shop-app#2's agent stalls; shop-app#6's agent is unchanged (a new but equal row).
      crew = [crewRow({ ticket: "shop-app#2", hudState: "stalled" }), studio("shop-app#6")];
      act(() => hub.refetch("/api/crew"));
      const c2 = card(container, "shop-app#2") as HTMLElement;
      await waitFor(() => expect(within(c2).getByText("Stalled")).toBeTruthy());
      expect([...new Set(renders)]).toEqual(["shop-app#2"]);
    } finally {
      cardRenderProbe.onRender = null;
    }
  });

  it("a Done card's age rolls over at midnight: today, then 1d ago", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(Date.UTC(2026, 9, 17, 22, 59, 55));
    stub({
      shopApp: [
        todo(7, { status: "Done", state: "done", updatedAt: Date.UTC(2026, 9, 17, 22, 0) }),
      ],
    });
    const { container } = await open();
    await waitFor(() =>
      expect(within(card(container, "shop-app#7") as HTMLElement).getByText("today")).toBeTruthy(),
    );
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    const c = card(container, "shop-app#7") as HTMLElement;
    expect(within(c).getByText("1d ago")).toBeTruthy();
    expect(within(c).queryByText("today")).toBeNull();
  });
});

const PROFILES: RepoProfile[] = [
  {
    id: "shop-app",
    github: "octo-org/shop-app",
    project: 2,
    statuses: [
      { status: "Todo", state: "planned", column: "Ready", items: 4 },
      { status: "In Progress", state: "in progress", column: "In progress", items: 2 },
      { status: "Done", state: "done", column: "Done", items: 9 },
    ],
    missingColumns: ["Refinement", "Blocked", "In review", "Ready for QA"],
    priority: { field: 11, label: 3, none: 1 },
    budget: { boardPerHour: 900, sweepPerHour: 12, flowPerHour: 8, totalPerHour: 920 },
    loops: [],
  },
  {
    id: "site-builder",
    github: "octo-org/site-builder",
    project: 3,
    statuses: [
      { status: "Backlog", state: "planned", column: "Backlog", items: 1 },
      { status: "Ready", state: "planned", column: "Ready", items: 0 },
      { status: "Blocked", state: "blocked", column: "Blocked", items: 0 },
      { status: "In Progress", state: "in progress", column: "In progress", items: 0 },
      { status: "In review", state: "review", column: "In review", items: 0 },
      { status: "QA", state: "review", column: "Ready for QA", items: 0 },
      { status: "Refine", state: "planned", column: "Refinement", items: 0 },
      { status: "Done", state: "done", column: "Done", items: 0 },
    ],
    missingColumns: [],
    priority: { field: 0, label: 2, none: 5 },
    budget: { boardPerHour: 300, sweepPerHour: 12, flowPerHour: 2, totalPerHour: 314 },
    loops: [],
  },
];

describe("repos together or apart", () => {
  const seed = () =>
    stub({
      shopApp: [todo(1)],
      engine: [todo(2, { repoId: "site-builder", status: "Refine" })],
      profiles: PROFILES,
    });
  const repoSeg = () => screen.queryByRole("group", { name: "Repos" });

  it("offers Together / Apart only in All repos with two repos, and remembers it", async () => {
    seed();
    const first = await open();
    await waitFor(() => expect(repoSeg()).toBeTruthy());
    const group = within(repoSeg() as HTMLElement);
    expect(group.getByRole("button", { name: "Together" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(group.getByRole("button", { name: "Apart" }));
    expect(localStorage.getItem("mc-board-layout")).toBe("apart");
    fireEvent.click(screen.getByRole("button", { name: "shop-app" }));
    expect(repoSeg()).toBeNull();
    first.unmount();
    window.history.replaceState(null, "", "/board");
    localStorage.setItem("mc-lane", "*");
    await open();
    await waitFor(() =>
      expect(
        within(repoSeg() as HTMLElement)
          .getByRole("button", { name: "Apart" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });

  it("Apart: one kanban per repo, headed with its priority source and what it lacks", async () => {
    seed();
    localStorage.setItem("mc-board-layout", "apart");
    const view = await open();
    await waitFor(() => expect(view.container.querySelectorAll(".repokanban").length).toBe(2));
    const [shopApp, engine] = Array.from(
      view.container.querySelectorAll<HTMLElement>(".repokanban"),
    );
    expect(shopApp?.querySelector("h3")?.textContent).toBe(
      "shop-app · Priority from Project field · Lacks Refinement, Blocked, In review, Ready for QA",
    );
    expect(engine?.querySelector("h3")?.textContent).toBe(
      "site-builder · Priority from p0\u2013p3 labels",
    );
    const heads = (el?: HTMLElement) =>
      Array.from(el?.querySelectorAll(".kh") ?? []).map((h) => h.textContent);
    expect(heads(shopApp).join("|")).not.toContain("Refinement");
    expect(heads(shopApp).join("|")).toContain("Ready");
    expect(heads(engine).join("|")).toContain("Refinement");
    const link = shopApp?.querySelector<HTMLAnchorElement>("a");
    expect(link?.textContent).toBe("How its statuses map");
    expect(link?.getAttribute("href")).toBe("/setup/repos");
  });

  const apartKanbans = async () => {
    localStorage.setItem("mc-board-layout", "apart");
    const view = await open();
    await waitFor(() => expect(view.container.querySelectorAll(".repokanban").length).toBe(2));
    return Array.from(view.container.querySelectorAll<HTMLElement>(".repokanban"));
  };
  const headsOf = (el?: HTMLElement) =>
    Array.from(el?.querySelectorAll(".kh") ?? []).map((h) => h.textContent);

  it("Apart: a repo's kanban always has Backlog and Done", async () => {
    seed();
    const [shopApp] = await apartKanbans();
    await waitFor(() =>
      expect(headsOf(shopApp)).toEqual(["Backlog 0", "Ready 1", "In progress 0", "Done 0"]),
    );
  });

  it("Apart: a column a card sits in is drawn though the profile lacks it", async () => {
    stub({
      shopApp: [todo(1), todo(5, { blockedBy: [{ ref: "shop-app#9", closed: false }] })],
      engine: [todo(2, { repoId: "site-builder" })],
      profiles: PROFILES,
    });
    const [shopApp] = await apartKanbans();
    await waitFor(() =>
      expect(headsOf(shopApp)).toEqual([
        "Backlog 0",
        "Blocked 1",
        "Ready 1",
        "In progress 0",
        "Done 0",
      ]),
    );
    const head = card(shopApp as HTMLElement, "shop-app#5")
      ?.closest(".kcol")
      ?.querySelector(".kh");
    expect(head?.textContent).toBe("Blocked 1");
  });

  it("Apart before profiles load: every column, headed by the repo id alone", async () => {
    const fetch = stub({
      shopApp: [todo(1)],
      engine: [todo(2, { repoId: "site-builder" })],
      profiles: () => ({ status: 503, body: { error: "unavailable" } }),
    });
    localStorage.setItem("mc-board-layout", "apart");
    const view = await open();
    await settled(fetch, "/api/repos/profiles");
    await waitFor(() => expect(view.container.querySelectorAll(".repokanban").length).toBe(2));
    const kanbans = Array.from(view.container.querySelectorAll<HTMLElement>(".repokanban"));
    expect(kanbans.map((k) => k.querySelector("h3")?.textContent)).toEqual([
      "shop-app",
      "site-builder",
    ]);
    for (const k of kanbans) expect(k.querySelectorAll(".kh").length).toBe(8);
  });

  it("an unknown stored layout reads as Together", async () => {
    localStorage.setItem("mc-board-layout", "sideways");
    seed();
    const view = await open();
    await waitFor(() => expect(repoSeg()).toBeTruthy());
    const group = within(repoSeg() as HTMLElement);
    expect(group.getByRole("button", { name: "Together" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(group.getByRole("button", { name: "Apart" }).getAttribute("aria-pressed")).toBe("false");
    expect(view.container.querySelectorAll(".repokanban").length).toBe(0);
  });

  it("Together: marks a column a repo lacks with not in {ids}", async () => {
    seed();
    const view = await open();
    await waitFor(() => expect(view.container.querySelector(".kcol .knot")).toBeTruthy());
    expect(view.container.querySelectorAll(".repokanban").length).toBe(0);
    const refinement = Array.from(view.container.querySelectorAll(".kcol")).find((c) =>
      c.querySelector(".kh")?.textContent?.startsWith("Refinement"),
    );
    expect(refinement?.querySelector(".knot")?.textContent).toBe("not in shop-app");
  });

  it("keeps the All repos layout under a session", async () => {
    seed();
    localStorage.setItem("mc-board-layout", "apart");
    act(() => setSession("shop-app"));
    const view = await open();
    expect(repoSeg()).not.toBeNull();
    expect(view.container.querySelectorAll(".repokanban").length).toBe(2);
    expect(view.container.querySelector(".kcol .knot")).toBeNull();
  });

  it.each([
    [{ field: 0, label: 45, none: 231 }, "p0\u2013p3 labels"],
    [{ field: 3, label: 10, none: 50 }, "Project field"],
    [{ field: 0, label: 0, none: 0 }, "nowhere"],
  ])("names the priority source the collector reads: %j", async (priority, expected) => {
    stub({
      shopApp: [todo(1)],
      engine: [todo(2, { repoId: "site-builder" })],
      profiles: PROFILES.map((p) => (p.id === "site-builder" ? { ...p, priority } : p)),
    });
    localStorage.setItem("mc-board-layout", "apart");
    const view = await open();
    await waitFor(() => expect(view.container.querySelectorAll(".repokanban").length).toBe(2));
    const h = view.container.querySelectorAll(".repokanban h3")[1]?.textContent;
    expect(h).toBe(`site-builder \u00b7 Priority from ${expected}`);
  });
});
