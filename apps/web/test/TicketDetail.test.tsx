import type { ConfigView, Crew } from "@mc/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TicketDetail } from "../src/components/TicketDetail.tsx";
import { RESOURCES, useResource } from "../src/data.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { stubFetch } from "./fetchStub.ts";
import { boardItem, CONFIG, CREW_CONFIG, crewRow, seatRow } from "./fixtures.ts";

const GH = "https://github.com/octo-org/shop-app";

const view = (over: Record<string, unknown> = {}) => ({
  number: 3349,
  title: "Quote cache",
  url: `${GH}/issues/3349`,
  state: "open",
  body: "first line\nsecond line",
  bodyTruncated: false,
  labels: ["perf"],
  milestone: "MVP",
  subIssues: [
    { number: 3350, title: "warm the cache", state: "closed", repoId: "shop-app" },
    { number: 3351, title: "evict", state: "open", repoId: "shop-app" },
  ],
  pullRequests: [
    { number: 40, title: "cache it", url: `${GH}/pull/40`, state: "merged" },
    { number: 41, title: "evil", url: "javascript:alert(1)", state: "open" },
    { number: 42, title: "dropped", url: `${GH}/pull/42`, state: "closed" },
  ],
  ...over,
});

const ticket = (body: unknown) => stubFetch({ "/api/boards/shop-app/items/3349": body });

const show = (props: Partial<Parameters<typeof TicketDetail>[0]> = {}) =>
  render(
    <TicketDetail
      repoId="shop-app"
      number={3349}
      item={boardItem({ stage: "Ready", owner: "CTO", milestone: "MVP" })}
      agent={null}
      {...props}
    />,
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TicketDetail", () => {
  it("shows the ticket's labels as chips", async () => {
    ticket(view({ labels: ["perf", "needs-qa"] }));
    show({ item: undefined });
    const pane = screen.getByRole("complementary", { name: "ticket" });
    await within(pane).findByText(/first line/);
    for (const l of ["perf", "needs-qa"]) {
      expect(within(pane).getByText(l).className).toBe("lb");
    }
  });

  it("shows the header, sub-issues, pull requests and the GitHub link", async () => {
    ticket(view());
    show();
    const pane = screen.getByRole("complementary", { name: "ticket" });
    await within(pane).findByText(/first line/);
    expect(within(pane).getByRole("heading", { name: "Quote cache" })).toBeTruthy();
    // the ticket page is one repo: the number alone, linked, no repo chip
    expect(within(pane).getByRole("link", { name: "shop-app #3349" }).getAttribute("href")).toBe(
      `${GH}/issues/3349`,
    );
    expect(pane.querySelector(".rchip")).toBeNull();
    for (const tag of ["In Progress", "Ready", "CTO", "MVP"]) {
      expect(within(pane).getByText(tag)).toBeTruthy();
    }
    expect(within(pane).getByText("warm the cache")).toBeTruthy();
    // no config here (it 404s): a pull request links to the server's URL if that is GitHub's
    await waitFor(() =>
      expect(within(pane).getByRole("link", { name: "shop-app PR #40" }).getAttribute("href")).toBe(
        `${GH}/pull/40`,
      ),
    );
    expect(within(pane).queryByRole("link", { name: "shop-app PR #41" })).toBeNull();
    expect(within(pane).getByText("PR #40")).toBeTruthy();
    expect(within(pane).getByText("PR #41")).toBeTruthy();
    expect(within(pane).getByText("evil")).toBeTruthy();
    expect(within(pane).getByRole("link", { name: "Open on GitHub ↗" }).getAttribute("href")).toBe(
      `${GH}/issues/3349`,
    );
    expect(within(pane).getByRole("link", { name: /Board/ }).getAttribute("href")).toBe(
      "/board/shop-app",
    );
  });

  it("says Open or Closed in words, never colour alone, and never green for closed", async () => {
    ticket(view());
    show();
    const pane = screen.getByRole("complementary", { name: "ticket" });
    await within(pane).findByText("warm the cache");
    const head = pane.querySelector("header") as HTMLElement;
    expect(within(head).getByText("Open").className).toBe("pill plain");
    const subs = within(pane).getByRole("list", { name: "Sub-issues" });
    expect(
      within(subs)
        .getAllByText(/^(Open|Closed)$/)
        .map((p) => [p.textContent, p.className]),
    ).toEqual([
      ["Closed", "pill plain"],
      ["Open", "pill plain"],
    ]);
    // pull requests carry prPill: Merged is a passing result (green), closed and open are plain
    const prs = within(pane).getByRole("list", { name: "Pull requests" });
    expect(
      within(prs)
        .getAllByText(/^(Merged|Open|Closed)$/)
        .map((p) => [p.textContent, p.className]),
    ).toEqual([
      ["Merged", "pill ok"],
      ["Open", "pill plain"],
      ["Closed", "pill plain"],
    ]);
  });

  it("a pull request from another repo links to its own URL, with that repo's name as the chip", async () => {
    stubFetch({
      "/api/boards/shop-app/items/3349": view({
        pullRequests: [
          {
            number: 7,
            title: "elsewhere",
            url: "https://github.com/octo-org/other/pull/7",
            state: "open",
          },
          { number: 40, title: "here", url: `${GH}/pull/40`, state: "open" },
        ],
      }),
      "/api/config": CONFIG,
    });
    show();
    const prs = await screen.findByRole("list", { name: "Pull requests" });
    const [other, here] = [...prs.querySelectorAll("li")] as HTMLElement[];
    await waitFor(() =>
      expect(
        within(other as HTMLElement)
          .getByRole("link", { name: "other PR #7" })
          .getAttribute("href"),
      ).toBe("https://github.com/octo-org/other/pull/7"),
    );
    expect(other?.querySelector(".rchip")?.textContent).toBe("other");
    expect(within(other as HTMLElement).getByText("elsewhere")).toBeTruthy();
    // a PR in the ticket's own repo still has no chip
    expect(here?.querySelector(".rchip")).toBeNull();
    expect(within(here as HTMLElement).getByRole("link", { name: "shop-app PR #40" })).toBeTruthy();
  });

  it("while the config is loading a pull request is plain text: no link, no chip", async () => {
    const stub = stubFetch({
      "/api/boards/shop-app/items/3349": view({
        pullRequests: [
          {
            number: 7,
            title: "elsewhere",
            url: "https://github.com/octo-org/other/pull/7",
            state: "open",
          },
        ],
      }),
    });
    // the config request never answers
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
      input === "/api/config" ? new Promise<Response>(() => {}) : stub(input, init),
    );
    show();
    const prs = await screen.findByRole("list", { name: "Pull requests" });
    const li = prs.querySelector("li") as HTMLElement;
    expect(li.querySelector(".rref")?.textContent).toBe("PR #7");
    expect(li.querySelector(".rchip")).toBeNull();
    expect(within(li).queryByRole("link")).toBeNull();
  });

  it("after a config error a pull request still links to the server's URL; a bad URL stays plain", async () => {
    stubFetch({
      "/api/boards/shop-app/items/3349": view({
        pullRequests: [
          {
            number: 7,
            title: "elsewhere",
            url: "https://github.com/octo-org/other/pull/7",
            state: "open",
          },
          { number: 9, title: "hostile", url: "javascript:alert(1)", state: "open" },
        ],
      }),
      "/api/config": () => ({ status: 503, body: { error: "config broken" } }),
    });
    show();
    const prs = await screen.findByRole("list", { name: "Pull requests" });
    const [good, bad] = [...prs.querySelectorAll("li")] as HTMLElement[];
    await waitFor(() =>
      expect(
        within(good as HTMLElement)
          .getByRole("link", { name: "shop-app PR #7" })
          .getAttribute("href"),
      ).toBe("https://github.com/octo-org/other/pull/7"),
    );
    expect(within(bad as HTMLElement).queryByRole("link")).toBeNull();
  });

  it("a pull request in the configured repo is linked from the config, not the URL's spelling of it", async () => {
    stubFetch({
      "/api/boards/shop-app/items/3349": view({
        pullRequests: [
          {
            number: 8,
            title: "same repo",
            url: "https://github.com/Octo-Org/shop-app/pull/8",
            state: "open",
          },
        ],
      }),
      "/api/config": CONFIG,
    });
    show();
    const prs = await screen.findByRole("list", { name: "Pull requests" });
    await waitFor(() =>
      expect(within(prs).getByRole("link", { name: "shop-app PR #8" }).getAttribute("href")).toBe(
        `${GH}/pull/8`,
      ),
    );
    expect(prs.querySelector(".rchip")).toBeNull();
  });

  it("a pull request is a RepoRef beside its title; the configured repo wins over a hostile URL", async () => {
    stubFetch({
      "/api/boards/shop-app/items/3349": view(),
      "/api/config": CONFIG,
    });
    show();
    const prs = await screen.findByRole("list", { name: "Pull requests" });
    const first = prs.querySelector("li") as HTMLElement;
    expect(first.querySelector(".rref")?.textContent).toBe("PR #40");
    expect(first.querySelector(".rchip")).toBeNull();
    expect(within(first).getByText("cache it")).toBeTruthy();
    await waitFor(() =>
      expect(
        within(first).getByRole("link", { name: "shop-app PR #40" }).getAttribute("href"),
      ).toBe(`${GH}/pull/40`),
    );
    // with the config loaded the configured repo wins: a non-GitHub URL is never followed
    // (without the config, the first test shows it falls back to the URL and drops a bad one)
    const evil = prs.querySelectorAll("li")[1] as HTMLElement;
    expect(within(evil).getByRole("link", { name: "shop-app PR #41" }).getAttribute("href")).toBe(
      `${GH}/pull/41`,
    );
  });

  it("sub-issues link to their own repo: no chip in the ticket's repo, a chip elsewhere, plain text when unconfigured", async () => {
    stubFetch({
      "/api/boards/shop-app/items/3349": view({
        subIssues: [
          { number: 11, title: "same repo", state: "open", repoId: "shop-app" },
          { number: 12, title: "other repo", state: "open", repoId: "site-builder" },
          { number: 13, title: "unconfigured", state: "open", repoId: null },
        ],
      }),
      "/api/config": CONFIG,
    });
    show();
    const subs = await screen.findByRole("list", { name: "Sub-issues" });
    const [same, other, none] = [...subs.querySelectorAll("li")] as HTMLElement[];
    await waitFor(() =>
      expect(within(same as HTMLElement).getByRole("link", { name: "shop-app #11" })).toBeTruthy(),
    );
    expect(same?.querySelector(".rchip")).toBeNull();
    await waitFor(() =>
      expect(
        within(other as HTMLElement)
          .getByRole("link", { name: "site-builder #12" })
          .getAttribute("href"),
      ).toBe("https://github.com/octo-org/site-builder/issues/12"),
    );
    expect(other?.querySelector(".rchip")?.textContent).toBe("site-builder");
    expect(within(none as HTMLElement).getByText("#13")).toBeTruthy();
    expect(within(none as HTMLElement).queryByRole("link")).toBeNull();
    expect(none?.querySelector(".rchip")).toBeNull();
  });

  it("a pull request in another configured repo links to that repo from the config, with its chip", async () => {
    stubFetch({
      "/api/boards/shop-app/items/3349": view({
        pullRequests: [
          {
            number: 5,
            title: "elsewhere",
            url: "javascript:alert(5)",
            state: "open",
            repoId: "site-builder",
          },
        ],
      }),
      "/api/config": CONFIG,
    });
    show();
    const prs = await screen.findByRole("list", { name: "Pull requests" });
    const li = prs.querySelector("li") as HTMLElement;
    await waitFor(() =>
      expect(
        within(li).getByRole("link", { name: "site-builder PR #5" }).getAttribute("href"),
      ).toBe("https://github.com/octo-org/site-builder/pull/5"),
    );
    expect(li.querySelector(".rchip")?.textContent).toBe("site-builder");
  });

  it("a pull request whose repoId is the ticket's own repo has no chip and links from the config", async () => {
    stubFetch({
      "/api/boards/shop-app/items/3349": view({
        pullRequests: [
          {
            number: 12,
            title: "same repo",
            url: "javascript:alert(12)",
            state: "open",
            repoId: "shop-app",
          },
        ],
      }),
      "/api/config": CONFIG,
    });
    show();
    const prs = await screen.findByRole("list", { name: "Pull requests" });
    const li = prs.querySelector("li") as HTMLElement;
    await waitFor(() =>
      expect(within(li).getByRole("link", { name: "shop-app PR #12" }).getAttribute("href")).toBe(
        `${GH}/pull/12`,
      ),
    );
    expect(li.querySelector(".rchip")).toBeNull();
  });

  it("a pull request with no repoId and a foreign URL takes the URL's repo as its chip", async () => {
    stubFetch({
      "/api/boards/shop-app/items/3349": view({
        pullRequests: [
          {
            number: 7,
            title: "elsewhere",
            url: "https://github.com/octo-org/other/pull/7",
            state: "open",
            repoId: null,
          },
        ],
      }),
      "/api/config": CONFIG,
    });
    show();
    const prs = await screen.findByRole("list", { name: "Pull requests" });
    const li = prs.querySelector("li") as HTMLElement;
    const link = await within(li).findByRole("link", { name: "other PR #7" });
    expect(link.getAttribute("href")).toBe("https://github.com/octo-org/other/pull/7");
    expect(li.querySelector(".rchip")?.textContent).toBe("other");
  });

  it("two items with the same number and no configured repo each keep their own row", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({
      "/api/boards/shop-app/items/3349": view({
        subIssues: [
          { number: 9, title: "first nine", state: "open", repoId: null },
          { number: 9, title: "second nine", state: "open", repoId: null },
        ],
        pullRequests: [
          {
            number: 7,
            title: "pr a",
            url: "https://github.com/x/a/pull/7",
            state: "open",
            repoId: null,
          },
          {
            number: 7,
            title: "pr b",
            url: "https://github.com/x/b/pull/7",
            state: "open",
            repoId: null,
          },
        ],
      }),
      "/api/config": CONFIG,
    });
    show();
    const subs = await screen.findByRole("list", { name: "Sub-issues" });
    expect(subs.querySelectorAll("li").length).toBe(2);
    const prs = await screen.findByRole("list", { name: "Pull requests" });
    expect(prs.querySelectorAll("li").length).toBe(2);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("same key"))).toEqual([]);
    warn.mockRestore();
  });

  it("a closed ticket says Closed", async () => {
    ticket(view({ state: "closed" }));
    show();
    const pane = screen.getByRole("complementary", { name: "ticket" });
    await within(pane).findByText("warm the cache");
    const head = pane.querySelector("header") as HTMLElement;
    expect(within(head).getByText("Closed").className).toBe("pill plain");
  });

  it("a closed ticket whose Status says Blocked shows one Closed pill and the flag", async () => {
    ticket(view({ state: "closed" }));
    show({ item: boardItem({ status: "Blocked", state: "blocked", closed: true }) });
    const pane = screen.getByRole("complementary", { name: "ticket" });
    await within(pane).findByText("warm the cache");
    const head = pane.querySelector("header") as HTMLElement;
    expect(
      within(head)
        .getAllByText(/^(Open|Closed)$/)
        .map((p) => p.textContent),
    ).toEqual(["Closed"]);
    expect(within(head).getByText("Status out of date").title).toBe(
      "GitHub says Closed; the board's Status says Blocked",
    );
    expect(within(head).queryByText("Blocked")).toBeNull();
  });

  it("before the ticket loads, the card's own closed state decides Open or Closed", () => {
    ticket(view());
    show({ item: boardItem({ status: "Done", state: "done", closed: true }) });
    const pane = screen.getByRole("complementary", { name: "ticket" });
    expect(within(pane).getByText("Closed")).toBeTruthy();
    expect(within(pane).queryByText("Status out of date")).toBeNull();
  });

  it("shows the agent on it with its state lamp and a link to its page", async () => {
    ticket(view());
    show({ agent: crewRow({ id: "shop-app-ta" }) });
    const sec = await screen.findByRole("region", { name: "Agent on it" });
    expect(sec.querySelector(".lamp")?.className).toBe("lamp ok pulse");
    // the state is read once: the word, not the lamp as well
    expect(sec.querySelector(".lamp")?.getAttribute("aria-hidden")).toBe("true");
    expect(within(sec).queryByRole("img")).toBeNull();
    expect(within(sec).getAllByText("Running")).toHaveLength(1);
    expect(within(sec).getByRole("link", { name: "shop-app-ta" }).getAttribute("href")).toBe(
      "/agent/shop-app-ta",
    );
  });

  it("a stalled or broken agent shows its state, not a green lamp", async () => {
    ticket(view());
    const { unmount } = show({ agent: crewRow({ hudState: "stalled" }) });
    const sec = await screen.findByRole("region", { name: "Agent on it" });
    expect(sec.querySelector(".lamp")?.className).toBe("lamp warn pulse");
    expect(within(sec).getByText("Stalled")).toBeTruthy();
    unmount();
    show({ agent: crewRow({ hudState: "error", sourceError: "state file unreadable" }) });
    const err = await screen.findByRole("region", { name: "Agent on it" });
    expect(err.querySelector(".lamp")?.className).toBe("lamp crit");
    expect(within(err).getByText("Error")).toBeTruthy();
  });

  it("omits sections with nothing in them", async () => {
    ticket(view({ body: "", subIssues: [], pullRequests: [] }));
    show();
    const pane = screen.getByRole("complementary", { name: "ticket" });
    await within(pane).findByRole("link", { name: "Open on GitHub ↗" });
    for (const h of ["Agent on it", "Description", "Sub-issues", "Pull requests"]) {
      expect(within(pane).queryByRole("heading", { name: h })).toBeNull();
    }
  });

  it("renders a body with HTML and script as text, line breaks kept", async () => {
    const body = '<img src=x onerror="alert(1)">\n<script>alert(2)</script>';
    ticket(view({ body }));
    show();
    const pane = screen.getByRole("complementary", { name: "ticket" });
    const box = await within(pane).findByText(/onerror/);
    expect(box.textContent).toBe(body);
    expect(pane.querySelector("img, script")).toBeNull();
    // a Markdown paragraph, which keeps pre-wrap (.md p), inside the description box
    expect(box.tagName).toBe("P");
    expect(box.parentElement?.className).toBe("md");
    expect(box.parentElement?.parentElement?.className).toBe("tbody");
  });

  it("links to GitHub to continue a truncated body", async () => {
    ticket(view({ body: "x".repeat(20_000), bodyTruncated: true }));
    show();
    const more = await screen.findByRole("link", { name: "Continue on GitHub ↗" });
    expect(more.getAttribute("href")).toBe(`${GH}/issues/3349`);
  });

  it("on a GitHub failure shows the error line and the card's facts", async () => {
    ticket(() => ({ status: 502, body: { error: "GitHub failed: github: HTTP 502" } }));
    show();
    const pane = screen.getByRole("complementary", { name: "ticket" });
    await within(pane).findByText(/Could not load the ticket: GitHub failed/);
    expect(within(pane).getByRole("heading", { name: "Quote cache" })).toBeTruthy();
  });

  it("says not found with a link back once the API answers 404; nothing while loading", async () => {
    ticket(() => ({ status: 404, body: { error: "unknown issue" } }));
    show({ item: undefined });
    const pane = screen.getByRole("complementary", { name: "ticket" });
    expect(within(pane).queryByText(/not found/)).toBeNull();
    await within(pane).findByText(/not found/);
  });
});

describe("Start a seat", () => {
  const BRANCH = "feature/3349-quote-cache";
  const idle = seatRow({ run: null, hudState: "idle" });
  const retro = seatRow({ id: "retro-1", role: "RETRO", mode: "read-only", area: [], run: null });
  const busy = (id: string) =>
    seatRow({
      id,
      run: {
        ...(crewRow().run as NonNullable<ReturnType<typeof crewRow>["run"]>),
        status: "running",
      },
      hudState: "running",
    });
  const stubStart = (extra: Record<string, unknown> = {}) =>
    stubFetch({
      "/api/boards/shop-app/items/3349": view(),
      "/api/config": CREW_CONFIG,
      "/api/crew": { rows: [idle, retro], firstRunToday: null },
      ...extra,
    });

  it("lists the free seats and says what the click does, then starts and goes to the Agent page", async () => {
    const fetchFn = stubStart({
      "POST /api/seats/guido-1/start": () => ({
        status: 200,
        body: { runId: "r1", branch: BRANCH },
      }),
    });
    render(
      <>
        <TicketDetail repoId="shop-app" number={3349} item={boardItem()} agent={null} />
        <Toast />
      </>,
    );
    const sec = await screen.findByRole("region", { name: "Start a seat" });
    const options = within(sec)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual([
      "GUIDO-1 · backend developer, test-first in its area",
      expect.stringMatching(/^RETRO-1 · /),
    ]);
    expect(sec.textContent).toContain(
      `Mission Control makes branch ${BRANCH} in its own clone and starts GUIDO-1 on it. Nothing is pushed.`,
    );
    fireEvent.click(within(sec).getByRole("button", { name: "Start GUIDO-1" }));
    await waitFor(() => expect(window.location.pathname).toBe("/agent/guido-1"));
    const post = fetchFn.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/api/seats/guido-1/start");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ issue: 3349 });
    expect(screen.getByRole("status").textContent).toBe("GUIDO-1 started on shop-app#3349.");
  });

  it("starts the seat that was picked", async () => {
    const fetchFn = stubStart({
      "POST /api/seats/retro-1/start": { runId: "r2", branch: BRANCH },
    });
    render(<TicketDetail repoId="shop-app" number={3349} item={boardItem()} agent={null} />);
    const sec = await screen.findByRole("region", { name: "Start a seat" });
    fireEvent.change(within(sec).getByRole("combobox"), { target: { value: "retro-1" } });
    expect(sec.textContent).toContain("starts RETRO-1 on it");
    fireEvent.click(within(sec).getByRole("button", { name: "Start RETRO-1" }));
    await waitFor(() =>
      expect(fetchFn.mock.calls.some(([u]) => u === "/api/seats/retro-1/start")).toBe(true),
    );
  });

  it("shows the server's refusal inline and stays on the ticket", async () => {
    stubStart({
      "POST /api/seats/guido-1/start": () => ({
        status: 409,
        body: { error: "crew is disabled on this server" },
      }),
    });
    render(<TicketDetail repoId="shop-app" number={3349} item={boardItem()} agent={null} />);
    const sec = await screen.findByRole("region", { name: "Start a seat" });
    window.history.replaceState(null, "", "/board/shop-app/3349");
    fireEvent.click(within(sec).getByRole("button", { name: "Start GUIDO-1" }));
    expect((await within(sec).findByRole("alert")).textContent).toBe(
      "crew is disabled on this server",
    );
    expect(window.location.pathname).toBe("/board/shop-app/3349");
    expect(
      (within(sec).getByRole("button", { name: "Start GUIDO-1" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("leaves busy seats out, and says so when none is free", async () => {
    stubStart({
      "/api/crew": { rows: [busy("guido-1"), retro], firstRunToday: null },
    });
    const { unmount } = render(
      <TicketDetail repoId="shop-app" number={3349} item={boardItem()} agent={null} />,
    );
    const sec = await screen.findByRole("region", { name: "Start a seat" });
    expect(within(sec).getAllByRole("option")).toHaveLength(1);
    expect(sec.textContent).not.toContain("GUIDO-1 ·");
    unmount();
    stubStart({
      "/api/crew": { rows: [busy("guido-1"), busy("retro-1")], firstRunToday: null },
    });
    render(<TicketDetail repoId="shop-app" number={3349} item={boardItem()} agent={null} />);
    expect(await screen.findByText("Every seat in s/s1 is busy.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Start / })).toBeNull();
  });

  it("leaves scratch seats out", async () => {
    const cfg = structuredClone(CREW_CONFIG);
    if (!cfg.crew) throw new Error("fixture has no crew");
    cfg.crew.sessions[0].seats[1].mode = "scratch";
    stubStart({ "/api/config": cfg });
    const { unmount } = render(
      <TicketDetail repoId="shop-app" number={3349} item={boardItem()} agent={null} />,
    );
    const sec = await screen.findByRole("region", { name: "Start a seat" });
    expect(
      within(sec)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["GUIDO-1 · backend developer, test-first in its area"]);
    unmount();
    stubStart({
      "/api/config": cfg,
      "/api/crew": { rows: [busy("guido-1"), retro], firstRunToday: null },
    });
    render(<TicketDetail repoId="shop-app" number={3349} item={boardItem()} agent={null} />);
    expect(await screen.findByText("Every seat in s/s1 is busy.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Start / })).toBeNull();
  });

  it("leaves watch seats out", async () => {
    const cfg = structuredClone(CREW_CONFIG);
    if (!cfg.crew) throw new Error("fixture has no crew");
    cfg.crew.sessions[0].seats[1].loop = "watch";
    stubStart({ "/api/config": cfg });
    render(<TicketDetail repoId="shop-app" number={3349} item={boardItem()} agent={null} />);
    const sec = await screen.findByRole("region", { name: "Start a seat" });
    expect(
      within(sec)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["GUIDO-1 · backend developer, test-first in its area"]);
  });

  // Renders the ticket beside a probe on the same config and crew resources, so "absent" is only
  // asserted once both have loaded and the section had its chance to appear.
  const absentOnceLoaded = async () => {
    function Loaded() {
      const config = useResource<ConfigView>(RESOURCES.config).data;
      const crew = useResource<Crew>(RESOURCES.crew).data;
      return config && crew ? <p>config and crew loaded</p> : null;
    }
    const r = render(
      <>
        <TicketDetail repoId="shop-app" number={3349} item={boardItem()} agent={null} />
        <Loaded />
      </>,
    );
    await screen.findByText("config and crew loaded");
    await screen.findByText("warm the cache");
    expect(screen.queryByRole("region", { name: "Start a seat" })).toBeNull();
    r.unmount();
  };

  it("is absent for a closed issue", async () => {
    stubStart({ "/api/boards/shop-app/items/3349": view({ state: "closed" }) });
    await absentOnceLoaded();
  });

  it("is absent for a repo with no crew session", async () => {
    stubStart({ "/api/config": CONFIG });
    await absentOnceLoaded();
  });

  it("counts a seat in error with a run still running as busy", async () => {
    const run = crewRow().run as NonNullable<ReturnType<typeof crewRow>["run"]>;
    stubStart({
      "/api/crew": {
        rows: [
          seatRow({ hudState: "error", run: { ...run, status: "running", endedAt: null } }),
          retro,
        ],
        firstRunToday: null,
      },
    });
    render(<TicketDetail repoId="shop-app" number={3349} item={boardItem()} agent={null} />);
    const sec = await screen.findByRole("region", { name: "Start a seat" });
    expect(within(sec).getAllByRole("option")).toHaveLength(1);
    expect(sec.textContent).not.toContain("GUIDO-1 ·");
  });
});
