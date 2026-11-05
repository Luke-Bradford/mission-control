import { type AttentionItem, DEFAULT_AWAY } from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Decisions } from "../src/comms/Decisions.tsx";
import { hub } from "../src/data.ts";
import { NeedsYouTab } from "../src/flight/NeedsYouTab.tsx";
import { openableHref } from "../src/links.ts";
import { briefLinks, briefPictures, pictureRoute } from "../src/needs/pictures.ts";
import { Needs } from "../src/pages/Needs.tsx";
import { navigate } from "../src/router.ts";
import { Header } from "../src/shell/Header.tsx";
import { stubFetch } from "./fetchStub.ts";
import { brief, CONFIG, crewRow, HOUR, item, MIN, NOW } from "./fixtures.ts";

const discussionPath = (key: string) => `/api/attention/${encodeURIComponent(key)}/discussion`;

/** Routes for the page: the items' discussions, empty unless a test gives them messages. */
function routes(
  items: AttentionItem[] | (() => { status: number; body: unknown }),
  more: Record<string, unknown> = {},
) {
  const list = Array.isArray(items) ? items : [];
  const discussions: Record<string, unknown> = {};
  for (const i of list) {
    const d = { id: `d:${i.key}`, itemKey: i.key, version: "v1", messages: [] };
    discussions[discussionPath(i.key)] = d;
    discussions[`${discussionPath(i.key)}?id=${encodeURIComponent(d.id)}`] = d;
  }
  return stubFetch({
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
    ...more,
  });
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
  window.history.replaceState(null, "", "/");
});

const ask = (key: string, over: Partial<AttentionItem> = {}) =>
  item({
    key,
    kind: "question",
    escalationId: null,
    text: `Question ${key}`,
    at: NOW - HOUR,
    brief: brief({
      recommendedOptionId: "a",
      options: [{ id: "a", label: "5174", answer: "Use 5174." }],
    }),
    ...over,
  });

describe("Needs you page", () => {
  it("lists what waits on you, and its count is the tab's", async () => {
    routes([
      ask("q1"),
      ask("q2"),
      ask("q3", { defaultDueAt: NOW + HOUR }),
      ask("q4", { owner: "flight" }),
    ]);
    render(
      <>
        <Header page="needs" />
        <Needs item={null} />
      </>,
    );
    expect(await screen.findByRole("link", { name: "Needs you: 3 waiting" })).toBeTruthy();
    const list = screen.getByRole("navigation", { name: "Waiting on you" });
    expect(within(list).getAllByRole("link")).toHaveLength(3);
    expect(within(list).getByRole("region", { name: "Waiting on you" }).textContent).toContain(
      "Waiting on you · 2",
    );
    expect(
      within(list).getByRole("region", { name: "FLIGHT will do unless you object" }),
    ).toBeTruthy();
    // the first item opens without changing the URL; the list marks it
    expect(window.location.pathname).toBe("/");
    expect(within(list).getAllByRole("link")[0]?.getAttribute("aria-current")).toBe("true");
  });

  it("says nobody is waiting with no items", async () => {
    routes([]);
    render(<Needs item={null} />);
    expect(await screen.findByText("Nobody is waiting on you.")).toBeTruthy();
  });

  it("says a named item is no longer open, and links to the next one without jumping", async () => {
    routes([ask("q1")]);
    render(<Needs item="gone" />);
    expect(await screen.findByText(/This item is no longer open\./)).toBeTruthy();
    const next = screen.getByRole("link", { name: "Next waiting item" });
    expect(next.getAttribute("href")).toBe("/needs-you/q1");
    expect(window.location.pathname).toBe("/");
  });

  it("shows … while the count loads and — when it cannot", async () => {
    let fail = false;
    routes(() => (fail ? { status: 500, body: { error: "down" } } : { status: 200, body: [] }));
    fail = true;
    render(<Header page="needs" />);
    expect(screen.getByRole("link", { name: "Needs you: loading" }).textContent).toBe(
      "Needs you …",
    );
    const tab = await screen.findByRole("link", { name: "Needs you: count unavailable" });
    expect(tab.textContent).toBe("Needs you —");
  });

  it("names a failed list and retries it", async () => {
    let ok = false;
    routes(() =>
      ok ? { status: 200, body: [] } : { status: 500, body: { error: "attention down" } },
    );
    render(<Needs item={null} />);
    expect((await screen.findByRole("alert")).textContent).toContain("attention down");
    ok = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Nobody is waiting on you.")).toBeTruthy();
  });

  it("keeps a typed draft when another item is opened and back", async () => {
    routes([ask("q1"), ask("q2")]);
    const view = render(<Needs item="q1" />);
    const box = (await screen.findByLabelText("Ask FLIGHT about this")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Half a thought" } });
    view.rerender(<Needs item="q2" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Ask FLIGHT about this") as HTMLTextAreaElement).value).toBe(
        "",
      ),
    );
    view.rerender(<Needs item="q1" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Ask FLIGHT about this") as HTMLTextAreaElement).value).toBe(
        "Half a thought",
      ),
    );
  });

  it("shows FLIGHT not triaging open, with what waits on it", async () => {
    routes([
      item({
        key: "flight:not-triaging",
        kind: "blocked",
        agentId: "flight-1",
        escalationId: null,
        text: "FLIGHT is not triaging: 1 waiting since 12:55.",
        notTriaging: { cause: "late", keys: ["ask:1"], since: NOW - 5 * MIN },
      }),
      item({
        key: "ask:1",
        kind: "question",
        escalationId: null,
        text: "GUIDO-1 asks: Which lane?",
        owner: "flight",
        flightTriage: "missed",
      }),
    ]);
    render(<Needs item={null} />);
    const row = await screen.findByTestId("not-triaging");
    expect(within(row).getByText("GUIDO-1 asks: Which lane?")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Hide them" })).toBeTruthy();
  });

  it("lists the recommendation of an ask with a default, apart from the asks", async () => {
    routes([
      ask("q1", { text: "Plain ask" }),
      ask("d1", { text: "Defaulted ask", defaultDueAt: NOW + 2 * HOUR }),
    ]);
    render(<Needs item={null} />);
    const list = await screen.findByRole("navigation", { name: "Waiting on you" });
    const asks = within(list).getByRole("region", { name: "Waiting on you" });
    expect(asks.textContent).toContain("Plain ask");
    expect(asks.textContent).not.toContain("Defaulted ask");
    expect(
      within(
        within(list).getByRole("region", { name: "FLIGHT will do unless you object" }),
      ).getAllByRole("link"),
    ).toHaveLength(1);
  });

  it("lists Held items as links to the Held panel, and Handled today under the list", async () => {
    routes([], {
      "/api/attention/held": [
        item({
          key: "hold:1",
          text: "Held item",
          hold: { reason: "waiting for CI", condition: { kind: "manual" }, at: NOW } as never,
        }),
      ],
      "/api/attention": [ask("q1")],
      "/api/notifications": {
        open: [],
        handledToday: [
          {
            id: "9",
            repoId: "shop-app",
            number: 3,
            title: "t",
            author: "bob",
            how: "marked handled",
            at: NOW - MIN,
            firstSeenAt: NOW - HOUR,
          },
        ],
      },
    });
    render(<Needs item={null} />);
    const held = await screen.findByRole("link", { name: /Held item/ });
    expect(held.getAttribute("href")).toBe("/flight#heldP");
    expect((await screen.findByTestId("handled-today")).textContent).toBe(
      "Handled today: bob (marked handled)",
    );
  });

  it("says the GitHub threads could not load, with Retry, and keeps the asks standing", async () => {
    routes([ask("q1")], {
      "/api/notifications": () => ({ status: 500, body: { error: "GitHub is down" } }),
    });
    render(<Needs item={null} />);
    const alert = await screen.findByText(
      "Could not load your GitHub threads: GitHub is down",
      {},
      { timeout: 4000 },
    );
    expect(
      within(alert.parentElement as HTMLElement).getByRole("button", { name: "Retry" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Question q1/ }).length).toBeGreaterThan(0);
  });

  it("shows a GitHub thread with its message inert, mentions marked", async () => {
    const snippet = '@CAPCOM <img src=x onerror="alert(1)"> @octocat-other';
    const key = `person:101:${NOW - HOUR}`;
    routes(
      [
        item({
          key,
          kind: "person",
          agentId: null,
          escalationId: null,
          ticket: null,
          url: null,
          text: "alice mentioned you: Fix the race",
        }),
      ],
      {
        "/api/notifications": {
          open: [
            {
              key,
              id: "101",
              repoId: "shop-app",
              github: "octo-org/shop-app",
              subjectType: "Issue",
              number: 12,
              title: "Fix the race",
              reason: "mention",
              reasonText: "mentioned you",
              author: "alice",
              snippet,
              url: "https://github.com/octo-org/shop-app/issues/12",
              updatedAt: NOW - HOUR,
              firstSeenAt: NOW - HOUR,
              catchUp: "new",
            },
          ],
          handledToday: [],
        },
      },
    );
    render(<Needs item={null} />);
    const quote = (await screen.findByText(/@CAPCOM/)).closest("blockquote") as HTMLElement;
    expect(quote.textContent).toBe(snippet);
    expect([...quote.querySelectorAll(".mention")].map((e) => e.textContent)).toEqual(["@CAPCOM"]);
    expect(quote.querySelector("img")).toBeNull();
  });
});

describe("links and pictures", () => {
  const withBrief = (original: string, over: Partial<AttentionItem> = {}) =>
    ask("q1", { brief: brief({ original }), url: null, ...over });

  it("links open in the browser and a file link is refused", async () => {
    routes([withBrief("[Spec](https://example.com/a) and [Mockup](file:///Users/x/m.html)")]);
    render(<Needs item={null} />);
    const spec = (await screen.findAllByRole("link", { name: "Spec" }))[0] as HTMLAnchorElement;
    expect(spec.getAttribute("href")).toBe("https://example.com/a");
    expect(spec.getAttribute("target")).toBe("_blank");
    expect(spec.getAttribute("rel")).toBe("noopener noreferrer");
    expect(spec.parentElement?.textContent).toContain("example.com");
    expect(screen.queryByRole("link", { name: "Mockup" })).toBeNull();
    expect(
      screen.getAllByText(
        "Not opened: file links can't open from the browser. Ask FLIGHT for a web link.",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("lists every link once: item url, brief links and a person's references", () => {
    const i = withBrief(
      "[Spec](https://example.com/a) https://example.com/a and https://b.example/x.",
      {
        url: "https://github.com/o/r/issues/1",
      },
    );
    expect(briefLinks(i).map((l) => l.url)).toEqual([
      "https://github.com/o/r/issues/1",
      "https://example.com/a",
      "https://b.example/x",
    ]);
  });

  it("makes a remote https image a link and requests nothing", async () => {
    const fetchMock = routes([withBrief("![Layout](https://evil.example/p.png)")]);
    const { container } = render(<Needs item={null} />);
    await screen.findAllByText(/Layout/);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByRole("link", { name: "Layout" })[0]?.getAttribute("href")).toBe(
      "https://evil.example/p.png",
    );
    expect(fetchMock.mock.calls.some(([p]) => String(p).includes("evil.example"))).toBe(false);
  });

  it("shows a hub picture large, from its route, with Fit width and Actual size", async () => {
    const path = `/api/prs/7/evidence/${"a".repeat(40)}/needs-light-after.png`;
    routes([withBrief(`![Proposed layout](${path})`)]);
    const { container } = render(<Needs item={null} />);
    const img = (await waitFor(() => {
      const el = container.querySelector(".needs-frame img");
      expect(el).not.toBeNull();
      return el;
    })) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(path);
    expect(img.alt).toBe("Proposed layout");
    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));
    expect(container.querySelector(".needs-frame.actual")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Fit width" })).toBeTruthy();
    fireEvent.error(img);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "This picture could not be loaded.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("says a picture that is not on the hub can't be shown", async () => {
    routes([withBrief("![Local](/Users/x/mockup.png)")]);
    render(<Needs item={null} />);
    expect(
      await screen.findByText(/This picture isn't stored on the hub, so it can't be shown here\./),
    ).toBeTruthy();
  });

  it.each([
    ["https://example.com/a", "https://example.com/a"],
    ["http://localhost:5173/x", "http://localhost:5173/x"],
    ["http://127.0.0.1/x", "http://127.0.0.1/x"],
    ["http://example.com/x", null],
    ["/api/prs/1", "/api/prs/1"],
    ["//evil.example/x", null],
    ["https://user:pw@example.com/", null],
    ["file:///Users/x/m.html", null],
    ["javascript:alert(1)", null],
    ["data:text/html,hi", null],
    ["blob:https://example.com/x", null],
    ["not a url", null],
    ["", null],
    ["/\\evil.example", null],
  ])("openableHref(%s) → %s", (url, out) => {
    expect(openableHref(url)).toBe(out);
  });

  it("pictureRoute allows only the hub's picture routes", () => {
    const sha = "b".repeat(40);
    expect(pictureRoute(`/api/prs/12/evidence/${sha}/needs-dark-diff.png`)).toEqual({
      path: `/api/prs/12/evidence/${sha}/needs-dark-diff.png`,
      auth: "hub",
    });
    expect(pictureRoute(`/api/hud-screenshots/${"1".repeat(32)}`)?.auth).toBe("operator");
    expect(pictureRoute(`/api/qa/review-shots/${"1".repeat(32)}`)?.auth).toBe("operator");
    expect(pictureRoute(`/api/qa-report-assets/${"1".repeat(64)}`)?.auth).toBe("operator");
    for (const bad of [
      "https://example.com/p.png",
      "/api/hud-screenshots/../../x",
      `/api/hud-screenshots/${"1".repeat(31)}`,
      `/api/prs/12/evidence/${sha}/x.png`,
      "/api/config",
    ])
      expect(pictureRoute(bad)).toBeNull();
    expect(
      briefPictures(withBriefItem("![a](/x.png) ![a](/x.png) ![b](/y.png)")).map((p) => p.label),
    ).toEqual(["a", "b"]);
  });
});

function withBriefItem(original: string): AttentionItem {
  return ask("p", { brief: brief({ original }) });
}

describe("other surfaces", () => {
  it("Comms decisions keep who, ticket, question and timing, and link to the page", () => {
    render(
      <Decisions
        items={[
          ask("decision:1", { kind: "decision", text: "Which cache?", defaultDueAt: NOW + 90_000 }),
        ]}
        rows={[crewRow()]}
      />,
    );
    const region = screen.getByRole("region", { name: "Decisions" });
    expect(within(region).getByText("Which cache?")).toBeTruthy();
    expect(within(region).getByText("default in 1:30")).toBeTruthy();
    expect(within(region).queryByRole("button")).toBeNull();
    expect(
      within(region).getByRole("link", { name: "Open in Needs you" }).getAttribute("href"),
    ).toBe("/needs-you/decision%3A1");
  });

  it("FLIGHT's Handling tab leads to Needs you", async () => {
    routes([]);
    render(<NeedsYouTab />);
    const link = await screen.findByRole("link", { name: "Open Needs you" });
    act(() => {
      fireEvent.click(link);
    });
    expect(window.location.pathname).toBe("/needs-you");
    navigate("/");
  });
});
