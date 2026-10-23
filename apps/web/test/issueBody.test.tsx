import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AutonomyQuestion } from "@mc/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TicketDetail } from "../src/components/TicketDetail.tsx";
import { BODY_LINES, ItemPanel } from "../src/shell/ItemPanel.tsx";
import { openItem } from "../src/shell/overlays.ts";
import { stubFetch } from "./fetchStub.ts";
import { boardItem, CONFIG, crewRow, escalation, item, NOW } from "./fixtures.ts";

const TICKET = "/api/boards/shop-app/items/4001";
const TICKET_B = "/api/boards/shop-app/items/4002";
const KEY = "esc:shop-app#4001";
const PROSE = ["__init__.py", "a*b", "1.", "-"];
const ticketView = (body: string, over: Record<string, unknown> = {}) => ({
  number: 4001,
  title: "Choose a cache eviction policy",
  url: "https://github.com/octo-org/shop-app/issues/4001",
  state: "open",
  body,
  bodyTruncated: false,
  labels: [],
  milestone: null,
  subIssues: [],
  pullRequests: [],
  ...over,
});
const QUESTION: AutonomyQuestion = {
  question: "Which policy?",
  recommendation: "LRU **now**",
  reasoning_quote: "r",
  effort_sunk: "e",
  default_if_ignored: "d",
  answers: ["LRU **now**", "LFU"],
};
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
const BLOCKS = "p, ul, ol, pre, .md";

interface Opts {
  question?: AutonomyQuestion | null;
  title?: string;
  /** Hold the ticket's answer back until `release()`. */
  hold?: boolean;
}

function open(ticket: unknown, { question = null, title, hold = false }: Opts = {}) {
  const fetch = stubFetch({
    "/api/attention": [item(), item({ key: "esc:shop-app#4002", escalationId: "shop-app#4002" })],
    "/api/escalations": [
      escalation({ question, ...(title ? { title } : {}) }),
      escalation({ id: "shop-app#4002", issueNumber: 4002, question, title: "Second" }),
    ],
    "/api/crew": { rows: [crewRow({ id: "shop-app-ta" })], firstRunToday: null },
    "/api/config": CONFIG,
    [TICKET]: ticket,
    [TICKET_B]: ticketView(lines(60), { number: 4002 }),
  });
  let release = () => {};
  if (hold) {
    const real = fetch.getMockImplementation() as (u: string, i?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", (u: string, i?: RequestInit) =>
      u === TICKET
        ? new Promise<Response>((done) => {
            release = () => done(new Response(JSON.stringify(ticket)));
          })
        : real(u, i),
    );
  }
  const view = render(<ItemPanel />);
  act(() => openItem(KEY));
  return { fetch, release: () => act(async () => release()), ...view };
}
const asked = (fetch: ReturnType<typeof stubFetch>, path: string) =>
  fetch.mock.calls.filter(([u]) => u === path).length;
const bodyText = (c: HTMLElement) => c.querySelector("#dsBrief .md")?.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Item panel: the question's own text", () => {
  it("shows the issue body, as Markdown, under the title when there is no structured question", async () => {
    const { container } = open(ticketView("Cut over **now**, with `--force`."));
    await screen.findByText("now");
    const body = container.querySelector("#dsBrief .md") as HTMLElement;
    expect(body.querySelector("strong")?.textContent).toBe("now");
    expect(body.querySelector("code")?.textContent).toBe("--force");
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });

  it("says Loading… while the body is on its way", async () => {
    const { release } = open(ticketView("the body"), { hold: true });
    await screen.findByText("Choose a cache eviction policy");
    expect(screen.getByText("Loading…")).toBeTruthy();
    await release();
    await screen.findByText("the body");
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("keeps the panel and adds one line with the error when the body fails", async () => {
    open(() => ({ status: 500, body: { error: "boom" } }));
    await screen.findByText("Could not load the question: boom");
    expect(screen.getByText("Reply on GitHub ↗")).toBeTruthy();
    expect(screen.getByText("Choose a cache eviction policy")).toBeTruthy();
  });

  it("cuts a body over the limit and shows the rest on Show all, then Show less", async () => {
    const { container } = open(ticketView(lines(BODY_LINES + 20)));
    await screen.findByRole("button", { name: "Show all" });
    expect(bodyText(container)).toContain(`line ${BODY_LINES}`);
    expect(bodyText(container)).not.toContain(`line ${BODY_LINES + 1}`);
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(bodyText(container)).toContain(`line ${BODY_LINES + 20}`);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(bodyText(container)).not.toContain(`line ${BODY_LINES + 1}`);
  });

  it("does not cut a body of exactly the limit", async () => {
    const { container } = open(ticketView(lines(BODY_LINES)));
    await screen.findByText(new RegExp(`line ${BODY_LINES}`));
    expect(bodyText(container)).toContain(`line ${BODY_LINES}`);
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });

  it("links to GitHub to continue a truncated body", async () => {
    open(ticketView("cut off mid", { bodyTruncated: true }));
    const link = await screen.findByRole("link", { name: "Continue on GitHub ↗" });
    expect(link.getAttribute("href")).toBe("https://github.com/octo-org/shop-app/issues/4001");
  });

  it("leaves a structured question's layout, with the body behind a toggle and not fetched before", async () => {
    const { fetch } = open(ticketView("the **issue** text"), { question: QUESTION });
    await screen.findByText("Which policy?");
    expect(asked(fetch, TICKET)).toBe(0);
    expect(screen.queryByText("issue")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Show all, the issue's text" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    await screen.findByText("issue");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByText("issue")).toBeNull();
  });

  it("makes one request across three toggles", async () => {
    const { fetch } = open(ticketView("the **issue** text"), { question: QUESTION });
    const toggle = await screen.findByRole("button", { name: /^Show all/ });
    fireEvent.click(toggle);
    await screen.findByText("issue");
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(screen.getByText("issue")).toBeTruthy();
    expect(asked(fetch, TICKET)).toBe(1);
  });

  it("does not carry Show all from one item to the next (no structured question)", async () => {
    const { container } = open(ticketView(lines(60)));
    fireEvent.click(await screen.findByRole("button", { name: "Show all" }));
    expect(bodyText(container)).toContain("line 60");
    act(() => openItem("esc:shop-app#4002"));
    await screen.findByText("Second");
    await screen.findByRole("button", { name: "Show all" });
    expect(bodyText(container)).not.toContain(`line ${BODY_LINES + 1}`);
  });

  it("does not carry an open body from one structured item to the next", async () => {
    const { container, fetch } = open(ticketView("the **issue** text"), { question: QUESTION });
    fireEvent.click(await screen.findByRole("button", { name: /^Show all/ }));
    await screen.findByText("issue");
    act(() => openItem("esc:shop-app#4002"));
    await screen.findByText("Second");
    expect(bodyText(container)).not.toContain("line 1");
    expect(asked(fetch, TICKET_B)).toBe(0);
    expect(screen.getByRole("button", { name: /^Show all/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("renders the title and the answers (recommendation included) as inline Markdown", async () => {
    const { container } = open(ticketView("b"), { question: QUESTION, title: "Cutover **now**" });
    await screen.findByText("Which policy?");
    expect(container.querySelector(".btitle strong")?.textContent).toBe("now");
    expect(container.querySelector(".optlist .opt.rec strong")?.textContent).toBe("now");
  });

  it("keeps the title and the answers to one line: a list marker is not a list", async () => {
    const q = { ...QUESTION, answers: ["1. retry", "- skip"], recommendation: "1. retry" };
    const { container } = open(ticketView("b"), { question: q, title: "1. retry" });
    await screen.findByText("Which policy?");
    const title = container.querySelector(".btitle") as HTMLElement;
    expect(title.textContent).toBe("1. retry");
    expect(title.querySelector(BLOCKS)).toBeNull();
    const opts = [...container.querySelectorAll<HTMLElement>(".optlist .opt")];
    expect(opts.map((o) => o.querySelector(".qtext")?.textContent)).toEqual(["1. retry", "- skip"]);
    for (const o of opts) expect(o.querySelector(BLOCKS)).toBeNull();
  });

  it.each(PROSE)("plain prose %j in a title and an answer is unchanged", async (t) => {
    const q = { ...QUESTION, answers: [t], recommendation: t };
    const { container } = open(ticketView("b"), { question: q, title: t });
    await screen.findByText("Which policy?");
    for (const el of [".btitle", ".optlist .qtext"]) {
      const e = container.querySelector(el) as HTMLElement;
      expect(e.textContent).toBe(t);
      expect(e.children).toHaveLength(0);
    }
  });
});

describe("TicketDetail body", () => {
  const show = () =>
    render(
      <TicketDetail
        repoId="shop-app"
        number={4001}
        item={boardItem({ issueNumber: 4001 })}
        agent={null}
      />,
    );

  it("renders the issue body as block Markdown", async () => {
    stubFetch({ [TICKET]: ticketView("- one\n- two\n\nsee `x` and __init__.py, a*b") });
    const { container } = show();
    await screen.findByText("one");
    expect(container.querySelectorAll(".tbody .md li")).toHaveLength(2);
    const body = container.querySelector(".tbody") as HTMLElement;
    expect(body.querySelector("code")?.textContent).toBe("x");
    expect(body.textContent).toContain("__init__.py, a*b");
  });

  it.each(PROSE)("plain prose %j is unchanged", async (text) => {
    stubFetch({ [TICKET]: ticketView(text) });
    const { container } = show();
    await screen.findByRole("heading", { name: "Description" });
    const body = container.querySelector(".tbody") as HTMLElement;
    expect(body.textContent).toBe(text);
    expect(body.querySelector("ul, ol, strong, em, code")).toBeNull();
  });
});

describe("Item panel layout (hud.css)", () => {
  const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
  const rule = (sel: string) => css.match(new RegExp(`\\n${sel} \\{([^}]*)\\}`))?.[1] ?? "";

  it("the body sits in the shrinkable brief grid and its text can shrink", async () => {
    const { container } = open(ticketView("x"));
    await screen.findByText("x");
    const body = container.querySelector("#dsBrief .md") as HTMLElement;
    expect(body.parentElement?.classList.contains("qtext")).toBe(true);
    expect(body.parentElement?.parentElement?.classList.contains("brief")).toBe(true);
    expect(rule(String.raw`\.brief`)).toContain("minmax(0, 1fr)");
    expect(rule(String.raw`\.qtext`)).toContain("min-width: 0");
    expect(rule(String.raw`\.md`)).toContain("min-width: 0");
  });
});
