import {
  type CmuxSessionRow,
  type CmuxSessionsView,
  SESSION_BUSY_TEXT,
  SESSION_NO_CHECKS_TEXT,
  SESSIONS_REFRESH_MS,
  type SessionRepoChecks,
} from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/hud.css";
import { hub } from "../src/data.ts";
import { Sessions } from "../src/pages/Sessions.tsx";
import { settled, stubFetch } from "./fetchStub.ts";

const NOW = Date.UTC(2026, 10, 25, 14, 32);
const MIN = 60_000;
const PATH = "/api/sessions";
const SIDEBAR_PATH = "/api/sessions/sidebar";

const SHOP = "/Users/op/Dev/shop-app";
const MC = "/Users/op/Dev/mission-control";

const ID = {
  pricing: "11111111-1111-4111-8111-111111111111",
  store: "22222222-2222-4222-8222-222222222222",
  guido: "33333333-3333-4333-8333-333333333333",
  api: "44444444-4444-4444-8444-444444444444",
};

const row = (
  over: Partial<CmuxSessionRow> & Pick<CmuxSessionRow, "id" | "name">,
): CmuxSessionRow => ({
  owner: "operator",
  folder: "/Users/op/Dev/shop-app",
  repo: "shop-app",
  repoKey: SHOP,
  state: "idle",
  since: NOW - 10 * MIN,
  lastLine: null,
  status: null,
  app: null,
  inbox: { unread: 0, newest: null },
  check: null,
  ...over,
});

const ROWS: CmuxSessionRow[] = [
  row({
    id: ID.api,
    name: "api server",
    state: "no-agent",
    since: NOW - 180 * MIN,
    lastLine: "GET /api/prices 200 in 14 ms",
    app: { url: "http://localhost:8080", answers: false },
  }),
  row({
    id: ID.store,
    name: "storefront",
    state: "working",
    since: NOW - 22 * MIN,
    lastLine: "Reworking the basket summary",
    status: "Basket redesign",
    app: { url: "http://localhost:5173", answers: true },
    inbox: { unread: 1, newest: "The pricing API is back." },
  }),
  row({
    id: ID.guido,
    name: "GUIDO-1 · #2235",
    owner: "crew",
    state: "working",
    since: NOW - 8 * MIN,
    folder: "/Users/op/Dev/mc-crew/worktrees/mission-control/guido-1-2235",
    repo: "mission-control",
    repoKey: MC,
    lastLine: "Running the sessions route tests",
  }),
  row({
    id: ID.pricing,
    name: "pricing",
    state: "waiting",
    since: NOW - 4 * MIN,
    lastLine: "Allow the migration to drop the old price_rules table?",
    status: "Moving prices",
    check: { state: "failed", at: NOW - 2 * MIN, command: "pnpm -s lint", why: "idle" },
  }),
];
const SHOP_CHECKS: SessionRepoChecks = {
  repo: SHOP,
  name: "shop-app",
  on: false,
  source: "repo",
  commands: ["pnpm -s lint", "pnpm -s test"],
  pageCommands: [],
};
const VIEW: CmuxSessionsView = { ok: true, at: NOW, sessions: ROWS, repos: [SHOP_CHECKS] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  hub.clear();
});

const bodyRows = () => screen.getAllByRole("row").slice(1);

describe("Sessions page", () => {
  it("lists every workspace, waiting first, with state words, age, last line and app", async () => {
    const fetch = stubFetch({ [PATH]: VIEW, [SIDEBAR_PATH]: { on: true } });
    render(<Sessions />);
    await settled(fetch, PATH);
    const names = bodyRows().map((r) => within(r).getAllByRole("cell")[0]?.textContent);
    expect(names).toEqual([
      "pricingYours",
      "storefrontYours1 unread",
      "GUIDO-1 · #2235Crew",
      "api serverYours",
    ]);
    const first = bodyRows()[0] as HTMLElement;
    expect(within(first).getByText("Waiting on you")).toBeTruthy();
    expect(within(first).getByText("4m")).toBeTruthy();
    expect(
      within(first).getByText("Allow the migration to drop the old price_rules table?"),
    ).toBeTruthy();
    expect(document.querySelector(".sess-summary")?.textContent).toBe(
      "4 sessions · 1 waiting on you · 2 working",
    );
    expect(screen.getByText("localhost:5173")).toBeTruthy();
    expect(screen.getByText("Answers")).toBeTruthy();
    expect(screen.getByText("Not answering")).toBeTruthy();
    // An unknown status reads as a dash, never blank.
    expect(within(bodyRows()[3] as HTMLElement).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows a branch's ticket and PR, and turns cmux writes off", async () => {
    const sidebar = vi.fn((_init: RequestInit | undefined) => ({
      status: 200,
      body: { on: false },
    }));
    const fetch = stubFetch({
      [PATH]: {
        ...VIEW,
        sessions: [
          row({
            id: ID.pricing,
            name: "pricing",
            branch: "feature/2262-cmux-sidebar",
            ticket: { number: 2262, repoId: "mission-control" },
            pr: {
              number: 2269,
              url: "https://github.com/Luke-Bradford/mission-control/pull/2269",
              isDraft: false,
              ci: "passing",
              review: "approved",
            },
          }),
        ],
      },
      [SIDEBAR_PATH]: { on: true },
      [`POST ${SIDEBAR_PATH}`]: sidebar,
    });
    render(<Sessions />);
    await settled(fetch, PATH);
    expect(screen.getByRole("link", { name: "#2262" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "PR 2269" })).toBeTruthy();
    expect(screen.getByText("CI passing")).toBeTruthy();
    expect(screen.getByText("Approved")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Write to cmux" }));
    await waitFor(() => expect(sidebar).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(sidebar.mock.calls[0]?.[0]?.body))).toEqual({ on: false });
    await waitFor(() => expect(screen.getByText(/cmux writes off/)).toBeTruthy());
  });

  it("refetches sessions when the sessions topic changes", async () => {
    let view = VIEW;
    const fetch = stubFetch({
      [PATH]: () => ({ status: 200, body: view }),
      [SIDEBAR_PATH]: { on: true },
    });
    render(<Sessions />);
    await settled(fetch, PATH);
    view = { ...VIEW, sessions: [row({ id: ID.pricing, name: "new workspace" })] };
    await act(async () => hub.refetchTopic("sessions"));
    expect(await screen.findByText("new workspace")).toBeTruthy();
  });

  it("clicking a row opens it in cmux", async () => {
    const focus = vi.fn(() => ({ status: 200, body: { ok: true } }));
    const fetch = stubFetch({ [PATH]: VIEW, [`POST ${PATH}/${ID.pricing}/focus`]: focus });
    render(<Sessions />);
    await settled(fetch, PATH);
    fireEvent.click(screen.getByText("pricing"));
    await waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(bodyRows()[1] as HTMLElement, { key: "Enter" });
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(`${PATH}/${ID.store}/focus`, expect.anything()),
    );
  });

  it("writes to one session and shows a busy answer inline", async () => {
    let busy = true;
    const send = vi.fn((init: RequestInit | undefined) =>
      busy
        ? { status: 409, body: { error: SESSION_BUSY_TEXT } }
        : { status: 200, body: { ok: true, sent: JSON.parse(String(init?.body)) } },
    );
    const fetch = stubFetch({ [PATH]: VIEW, [`POST ${PATH}/${ID.pricing}/send`]: send });
    render(<Sessions />);
    await settled(fetch, PATH);
    fireEvent.click(
      within(bodyRows()[0] as HTMLElement).getByRole("button", { name: "Write to pricing" }),
    );
    const box = screen.getByRole("textbox", { name: "Write to pricing" });
    fireEvent.change(box, { target: { value: "yes" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(SESSION_BUSY_TEXT)).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(send.mock.calls[0]?.[0]?.body))).toEqual({ text: "yes" });
    // A write button never focuses the row.
    expect(fetch).not.toHaveBeenCalledWith(`${PATH}/${ID.pricing}/focus`, expect.anything());
    busy = false;
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Write to pricing" })).toBeNull(),
    );
  });

  it("opens a session's app in its own cmux browser", async () => {
    const app = vi.fn(() => ({ status: 200, body: { ok: true } }));
    const fetch = stubFetch({ [PATH]: VIEW, [`POST ${PATH}/${ID.store}/app`]: app });
    render(<Sessions />);
    await settled(fetch, PATH);
    fireEvent.click(screen.getByRole("button", { name: /localhost:5173/ }));
    await waitFor(() => expect(app).toHaveBeenCalledTimes(1));
    expect(fetch).not.toHaveBeenCalledWith(`${PATH}/${ID.store}/focus`, expect.anything());
  });

  it("shows the newest inbox message from a keyboard disclosure that survives a refresh", async () => {
    const fetch = stubFetch({ [PATH]: VIEW });
    render(<Sessions />);
    await settled(fetch, PATH);
    const toggle = screen.getByRole("button", { name: "1 unread message for storefront" });
    expect(toggle.textContent).toBe("1 unread");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("The pricing API is back.")).toBeNull();
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    // Enter on the button opens the message, never the session.
    fireEvent.keyDown(toggle, { key: "Enter" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(panel?.textContent).toContain("The pricing API is back.");
    expect(fetch).not.toHaveBeenCalledWith(`${PATH}/${ID.store}/focus`, expect.anything());
    await act(async () => hub.refetch(PATH));
    await settled(fetch, PATH);
    expect(screen.getByText("The pricing API is back.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "1 unread message for storefront" }));
    expect(screen.queryByText("The pricing API is back.")).toBeNull();
  });

  it("says when no workspace is open", async () => {
    const fetch = stubFetch({ [PATH]: { ok: true, at: NOW, sessions: [], repos: [] } });
    render(<Sessions />);
    await settled(fetch, PATH);
    expect(screen.getByText("No cmux workspaces are open.")).toBeTruthy();
  });

  it("shows cmux's error as a banner, keeping the last good read", async () => {
    let down = false;
    const fetch = stubFetch({
      [PATH]: () =>
        down
          ? { status: 200, body: { ok: false, at: NOW + 3000, error: "cmux is not running." } }
          : { status: 200, body: VIEW },
    });
    render(<Sessions />);
    await settled(fetch, PATH);
    down = true;
    await act(async () => hub.refetch(PATH));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("cmux is not running."),
    );
    expect(screen.getByText("pricing")).toBeTruthy();
    expect(screen.getByText(/Last good read/)).toBeTruthy();
  });

  it("reads again every few seconds while open", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fetch = stubFetch({ [PATH]: VIEW });
    const view = render(<Sessions />);
    await settled(fetch, PATH);
    const reads = () => fetch.mock.calls.filter(([p]) => p === PATH).length;
    expect(reads()).toBe(1);
    await act(async () => vi.advanceTimersByTime(SESSIONS_REFRESH_MS));
    await waitFor(() => expect(reads()).toBe(2));
    view.unmount();
    await act(async () => vi.advanceTimersByTime(SESSIONS_REFRESH_MS * 3));
    expect(reads()).toBe(2);
  });

  it("shows each row's check in words, with its command and time in the title", async () => {
    const fetch = stubFetch({ [PATH]: VIEW, "/api/config": { operator: { timezone: "UTC" } } });
    render(<Sessions />);
    await settled(fetch, PATH);
    await settled(fetch, "/api/config");
    const failed = within(bodyRows()[0] as HTMLElement).getByText("Failed");
    expect(failed.closest("[title]")?.getAttribute("title")).toBe("pnpm -s lint · 14:30:00");
    // no check yet reads as a dash
    expect(within(bodyRows()[1] as HTMLElement).queryByText("Passed")).toBeNull();
  });

  it("runs a row's checks from its button, and offers none for a crew row or a repo with none", async () => {
    const run = vi.fn((_init: RequestInit | undefined) => ({ status: 200, body: { ok: true } }));
    const none = {
      ...SHOP_CHECKS,
      repo: "/Users/op/Dev/empty",
      name: "empty",
      source: null,
      commands: [],
    };
    const view: CmuxSessionsView = {
      ...VIEW,
      sessions: [
        ...ROWS,
        row({
          id: "55555555-5555-4555-8555-555555555555",
          name: "notes",
          repo: "empty",
          repoKey: none.repo,
        }),
      ],
      repos: [SHOP_CHECKS, none],
    };
    const fetch = stubFetch({ [PATH]: view, [`POST ${PATH}/${ID.pricing}/checks`]: run });
    render(<Sessions />);
    await settled(fetch, PATH);
    fireEvent.click(screen.getByRole("button", { name: "Run checks for pricing" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(run.mock.calls[0]?.[0]?.body))).toEqual({});
    expect(fetch).not.toHaveBeenCalledWith(`${PATH}/${ID.pricing}/focus`, expect.anything());
    expect(screen.queryByRole("button", { name: "Run checks for GUIDO-1 · #2235" })).toBeNull();
    const off = screen.getByRole("button", { name: "Run checks for notes" });
    expect(off).toHaveProperty("disabled", true);
    expect(off.getAttribute("title")).toBe(SESSION_NO_CHECKS_TEXT);
  });

  it("switches a repo's checks on from the Repo checks list, and edits a page list", async () => {
    let saved: unknown[] = [];
    const set = vi.fn((init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body));
      saved = [...saved, body];
      return body.commands?.includes("a && b")
        ? { status: 400, body: { error: "One plain command a line." } }
        : { status: 200, body: { ok: true } };
    });
    const page: SessionRepoChecks = {
      repo: "/Users/op/Dev/notes",
      name: "notes",
      on: false,
      source: null,
      commands: [],
      pageCommands: [],
    };
    const fetch = stubFetch({
      [PATH]: { ...VIEW, repos: [SHOP_CHECKS, page] },
      [`POST ${PATH}/checks`]: set,
    });
    render(<Sessions />);
    await settled(fetch, PATH);
    const list = screen.getByRole("region", { name: "Repo checks" });
    expect(within(list).getByText("From the repo's Mission Control block")).toBeTruthy();
    expect(within(list).getByText("No checks named")).toBeTruthy();
    // the repo's own block is not edited here
    expect(within(list).getAllByRole("button", { name: /^Edit/ })).toHaveLength(1);
    fireEvent.click(
      within(list).getByRole("checkbox", {
        name: "Run checks when a session finishes in shop-app",
      }),
    );
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(saved[0]).toEqual({ repo: SHOP, on: true });
    fireEvent.click(within(list).getByRole("button", { name: "Edit checks for notes" }));
    const box = within(list).getByRole("textbox", { name: "Checks for notes, one command a line" });
    fireEvent.change(box, { target: { value: "a && b" } });
    fireEvent.click(within(list).getByRole("button", { name: "Save" }));
    expect(await within(list).findByText("One plain command a line.")).toBeTruthy();
    fireEvent.change(box, { target: { value: "npm test\n\n  npm run lint  \n" } });
    fireEvent.click(within(list).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(3));
    expect(saved[2]).toEqual({ repo: page.repo, commands: ["npm test", "npm run lint"] });
  });
});
