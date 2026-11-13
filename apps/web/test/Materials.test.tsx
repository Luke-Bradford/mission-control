import {
  type AttentionItem,
  type AttentionMaterials,
  DEFAULT_AWAY,
  type TicketHistory,
} from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { mainTicket, planSection, retainedImageId } from "../src/needs/materials.ts";
import { PREVIEW_ORIGIN } from "../src/needs/PreviewFrame.tsx";
import { pictureRoute } from "../src/needs/pictures.ts";
import { Needs } from "../src/pages/Needs.tsx";
import { stubFetch } from "./fetchStub.ts";
import { brief, CONFIG, crewRow, HOUR, item, NOW } from "./fixtures.ts";

const id = (c: string) => c.repeat(64);
const asset = (c: string) => `/api/attention-material-assets/${id(c)}`;
const SHA = "a".repeat(40);

const ticketBody = (plan: string | null) =>
  `## Outcome\nShip it.\n\n${plan === null ? "" : `## Plan\n${plan}\n\n`}## Size\nM\n`;

function history(body: string | null, over: Partial<TicketHistory> = {}): TicketHistory {
  return {
    repoId: "shop-app",
    number: 4001,
    url: "https://github.com/octo-org/shop-app/issues/4001",
    title: "Cache policy",
    state: "open",
    status: null,
    priority: null,
    size: null,
    labels: [],
    outcome: null,
    doneWhen: [],
    body,
    bodyTruncated: false,
    githubError: body === null ? "rate limited" : null,
    runs: [],
    prs: [],
    questions: [],
    ...over,
  } as unknown as TicketHistory;
}

function packet(over: Partial<AttentionMaterials> = {}): AttentionMaterials {
  return {
    id: "p1",
    itemKey: "q1",
    repoId: "shop-app",
    sourceCommit: SHA,
    sourcePath: null,
    label: "Layout story",
    registeredAt: NOW - HOUR,
    briefId: null,
    sourceRevision: null,
    markdown: "",
    images: ["1", "2", "3"].map((c) => ({
      id: id(c),
      path: `shots/${c}.png`,
      label: null,
      mediaType: "image/png" as const,
      sha256: id(c),
      url: asset(c),
      size: 10,
    })),
    story: [
      {
        heading: "This page",
        text: "The list today.",
        images: [{ imageId: id("1"), caption: "Live page" }],
        comparison: null,
        children: [
          {
            heading: "Would change",
            text: "Rows get taller.",
            images: [
              { imageId: id("2"), caption: "Before" },
              { imageId: id("3"), caption: "After" },
            ],
            comparison: "before-after",
            children: [],
          },
        ],
      },
    ],
    optionImages: [{ optionId: "a", imageIds: [id("3")] }],
    historical: false,
    historicalReason: null,
    ...over,
  };
}

const ask = (key = "q1", over: Partial<AttentionItem> = {}): AttentionItem =>
  item({
    key,
    kind: "question",
    escalationId: null,
    ticket: "shop-app#4001",
    text: `Question ${key}`,
    at: NOW - HOUR,
    brief: brief({
      options: [
        { id: "a", label: "Rows taller", answer: "Taller rows." },
        { id: "b", label: "Keep rows", answer: "Keep." },
      ],
    }),
    ...over,
  });

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** The page's routes; picture routes answer PNG bytes unless `failing` names them. */
function routes(
  items: AttentionItem[],
  more: Record<string, unknown> = {},
  failing: string[] = [],
) {
  const fn = stubFetch({
    "/api/config": CONFIG,
    "/api/crew?shape=summary": { rows: [crewRow()], firstRunToday: null },
    "/api/attention": items,
    "/api/attention/answered": [],
    "/api/attention/held": [],
    "/api/notifications": { open: [], handledToday: [] },
    "/api/flight": { seat: null, decisions: [] },
    "/api/test-lock": { holder: null, waiting: [] },
    "/api/settings/away": DEFAULT_AWAY,
    "/api/machine": { latest: null },
    "/api/limits": [],
    ...more,
  });
  const inner = fn.getMockImplementation() as (i: string, init?: RequestInit) => Promise<Response>;
  const wrapped = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.startsWith("/api/attention-material-assets/")) {
      return failing.includes(input)
        ? new Response("no", { status: 500 })
        : new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    }
    return inner(input, init);
  });
  vi.stubGlobal("fetch", wrapped);
  return wrapped;
}

const matPath = (key: string) => `/api/attention/${encodeURIComponent(key)}/materials`;
const TICKET = "/api/tickets/shop-app/4001";

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

describe("plan and ticket reading", () => {
  it("takes the whole Plan section with nested headings, not the sections around it", () => {
    const body = ticketBody("1. One\n### Nested\n- two\n```\n## not a heading\n```\nlast");
    const plan = planSection(body) ?? "";
    expect(plan).toContain("### Nested");
    expect(plan).toContain("## not a heading");
    expect(plan.endsWith("last")).toBe(true);
    expect(plan).not.toContain("Size");
    expect(planSection(ticketBody(null))).toBeNull();
  });

  it("uses only a canonical repo#number as the main ticket, never a PR label", () => {
    expect(mainTicket({ ticket: "PR 1600", brief: { ticket: "mission-control#1513" } })).toEqual({
      repoId: "mission-control",
      number: 1513,
    });
    expect(mainTicket({ ticket: "PR 1600" })).toBeNull();
    expect(mainTicket({ ticket: "#1600" })).toBeNull();
  });

  it("allows exactly the retained image route", () => {
    expect(pictureRoute(asset("a"))?.auth).toBe("operator");
    expect(retainedImageId(asset("a"))).toBe(id("a"));
    for (const bad of [
      `/api/attention-material-assets/${"a".repeat(63)}`,
      `/api/attention-material-assets/${id("a")}/x`,
      `https://example.com${asset("a")}`,
      `/api/attention-material-assets/${id("a")}?x=1`,
    ])
      expect(pictureRoute(bad)).toBeNull();
  });
});

describe("Plan and mockups in the question", () => {
  it("shows the main ticket's full plan with no packet registered", async () => {
    routes([ask()], { [TICKET]: history(ticketBody("1. First\n### Detail\n- nested point")) });
    render(<Needs item="q1" />);
    const region = await screen.findByRole("region", { name: "Plan of shop-app#4001" });
    expect(within(region).getByText("Detail")).toBeTruthy();
    expect(within(region).getByText("nested point")).toBeTruthy();
    expect(screen.getByText("No pictures are attached to this question.")).toBeTruthy();
  });

  it("says so when the ticket has no plan, and links to the whole ticket", async () => {
    routes([ask()], { [TICKET]: history(ticketBody(null)) });
    render(<Needs item="q1" />);
    expect(await screen.findByText(/This ticket has no Plan section/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the full ticket" })).toBeTruthy();
  });

  it("is honest when GitHub could not be read, and when the text was cut", async () => {
    routes([ask()], { [TICKET]: history(null) });
    render(<Needs item="q1" />);
    expect(await screen.findByText(/could not be read from GitHub: rate limited/)).toBeTruthy();
    cleanup();
    hub.clear();
    routes([ask()], {
      [TICKET]: history(ticketBody("1. One"), { bodyTruncated: true }),
    });
    render(<Needs item="q1" />);
    expect(await screen.findByText(/ticket text was cut/)).toBeTruthy();
  });

  it("shows a failed ticket read as an error with Retry", async () => {
    routes([ask()], { [TICKET]: () => ({ status: 500, body: { error: "boom" } }) });
    render(<Needs item="q1" />);
    expect(await screen.findByText(/Could not load the plan of shop-app#4001: boom/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry loading the plan" })).toBeTruthy();
  });

  it("shows the story nested, a before/after side by side, and steps through them with arrows", async () => {
    const fn = routes([ask()], {
      [TICKET]: history(ticketBody("1. x")),
      [matPath("q1")]: { packets: [packet()] },
    });
    render(<Needs item="q1" />);
    const mat = await screen.findByRole("region", { name: "Plan and mockups" });
    await within(mat).findByRole("heading", { name: "This page" });
    const nested = within(mat).getByRole("heading", { name: "Would change" });
    expect(nested.closest("[data-depth='1']")).toBeTruthy();
    const compare = nested.closest("section")?.querySelector("[data-comparison='before-after']");
    expect(compare).toBeTruthy();
    expect(within(compare as HTMLElement).getByText("Before")).toBeTruthy();
    expect(within(compare as HTMLElement).getByText("After")).toBeTruthy();
    const before = await within(compare as HTMLElement).findByRole("button", {
      name: "Open Before full size",
    });
    fireEvent.click(before);
    const dialog = await screen.findByRole("dialog", { name: "Picture: Before" });
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(await screen.findByRole("dialog", { name: "Picture: After" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "Picture: After" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));
    expect(screen.getByRole("button", { name: "Fit width" })).toBeTruthy();
    // reading never chooses or acknowledges anything
    expect(fn.mock.calls.filter(([, init]) => init?.method && init.method !== "GET")).toEqual([]);
  });

  it("puts a picture on the option it shows", async () => {
    routes([ask()], {
      [TICKET]: history(ticketBody("1. x")),
      [matPath("q1")]: { packets: [packet()] },
    });
    render(<Needs item="q1" />);
    const option = (await screen.findByRole("button", { name: "Rows taller" })).closest(".opt");
    expect(option).toBeTruthy();
    const pic = await within(option as HTMLElement).findByRole("button", {
      name: "Open 3.png full size",
    });
    expect(pic).toBeTruthy();
    const other = screen.getByRole("button", { name: "Keep rows" }).closest(".opt");
    expect(within(other as HTMLElement).queryByRole("button", { name: /full size/ })).toBeNull();
  });

  it("shows source, kept time and historical status of a plan packet; relative links are not links", async () => {
    routes([ask()], {
      [TICKET]: history(ticketBody("1. x")),
      [matPath("q1")]: {
        packets: [
          packet({
            story: null,
            sourcePath: "docs/plan.md",
            markdown: `See [notes](notes.md) and [shot](${asset("1")}).\n\n![Proposed](${asset("2")})`,
            historical: true,
            historicalReason: "source changed",
          }),
        ],
      },
    });
    render(<Needs item="q1" />);
    const article = await screen.findByRole("article", { name: "Layout story" });
    expect(article.textContent).toContain("docs/plan.md at aaaaaaa");
    expect(article.textContent).toContain("Historical: the source changed since");
    expect(within(article).getByText("(not attached to this question)")).toBeTruthy();
    expect(within(article).queryByRole("link", { name: "notes" })).toBeNull();
    fireEvent.click(within(article).getByRole("button", { name: "shot" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("offers Retry on a picture that failed to load", async () => {
    routes(
      [ask()],
      {
        [TICKET]: history(ticketBody("1. x")),
        [matPath("q1")]: { packets: [packet()] },
      },
      [asset("1")],
    );
    render(<Needs item="q1" />);
    expect(await screen.findByText("This picture could not be loaded.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
  });

  it("asks for materials only for the open item, and another item never shows this packet", async () => {
    const fn = routes([ask("q1"), ask("q2", { ticket: "shop-app#4002" })], {
      [TICKET]: history(ticketBody("1. x")),
      [matPath("q1")]: { packets: [packet()] },
    });
    render(<Needs item="q2" />);
    await screen.findByText("No pictures are attached to this question.");
    expect(screen.queryByRole("heading", { name: "This page" })).toBeNull();
    const asked = fn.mock.calls.map(([p]) => p as string);
    expect(asked).toContain(matPath("q2"));
    expect(asked).not.toContain(matPath("q1"));
  });
});

describe("review fixes", () => {
  it("makes a link in the plan a real link", async () => {
    routes([ask()], {
      [TICKET]: history(
        ticketBody("See [the spec](https://github.com/octo-org/shop-app/blob/main/docs/spec.md)"),
      ),
    });
    render(<Needs item="q1" />);
    const region = await screen.findByRole("region", { name: "Plan of shop-app#4001" });
    expect(within(region).getByRole("link", { name: "the spec" }).getAttribute("href")).toBe(
      "https://github.com/octo-org/shop-app/blob/main/docs/spec.md",
    );
  });

  it("offers Retry when the materials read fails, and asks again", async () => {
    const fn = routes([ask()], {
      [TICKET]: history(ticketBody("1. x")),
      [matPath("q1")]: () => ({ status: 500, body: { error: "boom" } }),
    });
    render(<Needs item="q1" />);
    const retry = await screen.findByRole("button", { name: "Retry loading the materials" });
    const before = fn.mock.calls.filter(([p]) => p === matPath("q1")).length;
    fireEvent.click(retry);
    await waitFor(() =>
      expect(fn.mock.calls.filter(([p]) => p === matPath("q1")).length).toBeGreaterThan(before),
    );
  });

  it("keeps focus inside the viewer and keeps the arrow keys working at the last picture", async () => {
    routes([ask()], {
      [TICKET]: history(ticketBody("1. x")),
      [matPath("q1")]: { packets: [packet()] },
    });
    render(<Needs item="q1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Before full size" }));
    const dialog = await screen.findByRole("dialog", { name: "Picture: Before" });
    const close = within(dialog).getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    const next = within(dialog).getByRole("button", { name: "Next" });
    next.focus();
    fireEvent.click(next);
    const last = await screen.findByRole("dialog", { name: "Picture: After" });
    expect(last.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(await screen.findByRole("dialog", { name: "Picture: Before" })).toBeTruthy();
  });
});

describe("Preview of a PR-labelled item", () => {
  const view = (over = {}) => ({
    ticket: 1513,
    repoId: "shop-app",
    branch: "feature/1513-old",
    sha: "b".repeat(40),
    publishedAt: NOW - 5 * HOUR,
    pr: 1600,
    running: false,
    url: `${PREVIEW_ORIGIN}/`,
    ...over,
  });
  const prItem = () =>
    ask("pr", {
      ticket: "PR 1600",
      brief: brief({
        ticket: "shop-app#1513",
        options: [{ id: "a", label: "Yes", answer: "Yes" }],
      }),
    });

  it("finds the preview by the brief's ticket and labels its branch and source", async () => {
    routes([prItem()], { "/api/design-previews": [view()] });
    render(<Needs item="pr" />);
    expect(await screen.findByRole("button", { name: "Open preview" })).toBeTruthy();
    expect(screen.getByText(/Branch preview of feature\/1513-old at bbbbbbb/)).toBeTruthy();
    expect(screen.getByText(/not the mockup this question asks about/)).toBeTruthy();
  });

  it("offers nothing for another repo's build of the same number", async () => {
    routes([prItem()], { "/api/design-previews": [view({ repoId: "site-builder" })] });
    render(<Needs item="pr" />);
    await screen.findAllByText("Question pr");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByRole("button", { name: "Open preview" })).toBeNull();
  });
});

describe("waiting", () => {
  it("does not hold the page while materials load", async () => {
    routes([ask()], {
      [TICKET]: history(ticketBody("1. x")),
      [matPath("q1")]: () => new Promise(() => {}),
    });
    render(<Needs item="q1" />);
    expect(await screen.findByText("Loading the attached materials…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rows taller" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Plan of shop-app#4001" })).toBeTruthy(),
    );
  });
});
