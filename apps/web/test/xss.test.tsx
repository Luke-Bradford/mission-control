import type { ConfigView } from "@mc/core";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigYaml } from "../src/components/config/ConfigYaml.tsx";
import { TicketDetail } from "../src/components/TicketDetail.tsx";
import { githubHref } from "../src/links.ts";
import { Agent } from "../src/pages/Agent.tsx";
import { BoardPage } from "../src/pages/BoardPage.tsx";
import { Comms } from "../src/pages/Comms.tsx";
import { ItemPanel } from "../src/shell/ItemPanel.tsx";
import { openItem } from "../src/shell/overlays.ts";
import { stubFetch } from "./fetchStub.ts";
import { boardItem, CONFIG, crewRow, escalation, item, NOW, REPOS, run } from "./fixtures.ts";

const PAYLOAD = "<img src=x onerror=alert(1)>";
const SCRIPT = "<script>alert(1)</script>";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("untrusted text renders literally", () => {
  it("ticket title, body, labels, sub-issues and pull requests", async () => {
    stubFetch({
      "/api/boards/shop-app/items/3349": {
        number: 3349,
        title: PAYLOAD,
        url: "javascript:alert(1)",
        state: "open",
        body: PAYLOAD + SCRIPT,
        bodyTruncated: false,
        labels: [PAYLOAD],
        milestone: SCRIPT,
        subIssues: [{ number: 1, title: PAYLOAD, state: "open" }],
        pullRequests: [{ number: 2, title: SCRIPT, url: "javascript:alert(2)", state: "open" }],
      },
    });
    render(
      <TicketDetail
        repoId="shop-app"
        number={3349}
        item={boardItem({ title: PAYLOAD, status: SCRIPT, owner: PAYLOAD as never })}
        agent={null}
      />,
    );
    const pane = screen.getByRole("complementary", { name: "ticket" });
    await within(pane).findByText(PAYLOAD + SCRIPT);
    expect(pane.querySelector("img, script")).toBeNull();
    expect(pane.textContent?.split(PAYLOAD).length).toBeGreaterThan(3);
    // javascript: URLs never become links
    for (const a of pane.querySelectorAll("a")) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    }
  });

  it("board cards, labels, milestones, blockers and the brief", async () => {
    stubFetch({
      "/api/repos": REPOS,
      "/api/config": CONFIG,
      "/api/boards/shop-app": [
        boardItem({
          title: PAYLOAD + SCRIPT,
          labels: [PAYLOAD, SCRIPT],
          milestone: PAYLOAD,
          priority: SCRIPT,
          size: PAYLOAD,
          status: "Blocked",
          state: "blocked",
          blockedBy: [{ ref: PAYLOAD, closed: false }],
        }),
      ],
      "/api/boards/site-builder": [],
      "/api/repos/shop-app/prs?linked=1": [],
      "/api/repos/site-builder/prs?linked=1": [],
      "/api/crew": { rows: [crewRow({ ticket: "shop-app#3349" })], firstRunToday: null },
      "/api/attention": [],
    });
    const { container } = render(<BoardPage repoId={null} ticket={null} />);
    await screen.findByText(PAYLOAD + SCRIPT);
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.textContent?.split(PAYLOAD).length).toBeGreaterThan(5);
    act(() => screen.getByRole("button", { name: "Standup brief" }).click());
    const brief = screen.getByRole("dialog", { name: "Brief" });
    expect(brief.querySelector("img, script")).toBeNull();
    expect(brief.textContent).toContain(PAYLOAD + SCRIPT);
  });

  it("config view: ids, paths and labels", () => {
    const config: ConfigView = {
      ...CONFIG,
      operator: { id: PAYLOAD, timezone: SCRIPT },
      loops: CONFIG.loops.map((l) => ({ ...l, id: PAYLOAD, worktree: SCRIPT })),
      repos: CONFIG.repos.map((r) => ({ ...r, needsYouLabels: [PAYLOAD] })),
    };
    const { container } = render(<ConfigYaml config={config} />);
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.textContent).toContain(JSON.stringify(PAYLOAD));
    expect(container.textContent).toContain(JSON.stringify(SCRIPT));
  });

  it("item panel: the question, reasoning, effort, default and answers", async () => {
    stubFetch({
      "/api/attention": [item({ text: PAYLOAD })],
      "/api/escalations": [
        escalation({
          title: SCRIPT,
          url: "javascript:alert(3)",
          question: {
            question: PAYLOAD,
            recommendation: PAYLOAD + SCRIPT,
            reasoning_quote: SCRIPT + PAYLOAD,
            effort_sunk: PAYLOAD,
            default_if_ignored: SCRIPT,
            answers: [PAYLOAD + SCRIPT, PAYLOAD],
          },
        }),
      ],
      "/api/crew": { rows: [], firstRunToday: null },
      "/api/config": CONFIG,
    });
    const { container } = render(<ItemPanel />);
    act(() => openItem("esc:shop-app#4001"));
    await screen.findByText(SCRIPT + PAYLOAD);
    expect(container.querySelector("img, script")).toBeNull();
    const text = container.textContent ?? "";
    // the question, the reasoning, the effort and both answers, each shown once as text
    expect(text.split(PAYLOAD).length - 1).toBe(5);
    expect(text).toContain(SCRIPT);
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    }
  });

  it("agent stream: every kind's text, tool name, input and result; subagents and files", async () => {
    stubFetch({
      "/api/config": CONFIG,
      "/api/crew": {
        rows: [
          crewRow({
            ticketTitle: PAYLOAD,
            digest: {
              toolCalls: 1,
              turns: 1,
              lastEventAt: NOW,
              model: SCRIPT,
              contextTokens: null,
              contextWindow: null,
              liveTool: { name: PAYLOAD, since: NOW },
              tools: {},
              subagents: [
                {
                  taskId: "t",
                  type: SCRIPT,
                  description: PAYLOAD,
                  status: "running",
                  tokens: null,
                  toolUses: null,
                  durationMs: null,
                },
              ],
              minuteTokens: [],
              turnUsage: [],
              background: [{ taskId: "b", description: PAYLOAD, type: SCRIPT }],
              compactions: 0,
            },
          }),
        ],
        firstRunToday: null,
      },
      "/api/attention": [],
      "/api/limits": [],
      "/api/agents/shop-app-ta/runs?limit=50": [run({ ticket: PAYLOAD })],
      "/api/agents/shop-app-ta/files": {
        files: [{ path: PAYLOAD, add: 1, del: 0, state: "untracked" }],
        note: SCRIPT,
      },
      "/api/agents/shop-app-ta/stream": {
        runId: "r-12",
        events: (["op", "msg", "think", "sys"] as const)
          .map((kind, i) => ({
            id: `${i}:0`,
            at: NOW,
            kind,
            text: `${kind}:${PAYLOAD}`,
          }))
          .concat([
            {
              id: "9:0",
              at: NOW,
              kind: "tool" as never,
              text: PAYLOAD,
              tool: { name: PAYLOAD, input: SCRIPT, result: PAYLOAD + SCRIPT, ms: 5, error: false },
            } as never,
          ]),
        truncated: false,
        lastOutputAt: NOW,
        reason: null,
      },
    });
    const { container } = render(<Agent id="shop-app-ta" />);
    await screen.findByText(`think:${PAYLOAD}`);
    const stream = container.querySelector("#stream") as HTMLElement;
    for (const k of ["op", "msg", "think", "sys"])
      expect(stream.textContent).toContain(`${k}:${PAYLOAD}`);
    const pre = stream.querySelector("details pre")?.textContent ?? "";
    expect(pre).toContain(`input: ${SCRIPT}`);
    expect(pre).toContain(`result: ${PAYLOAD + SCRIPT}`);
    expect(container.querySelector("#liveCall")?.textContent).toContain(PAYLOAD);
    act(() =>
      within(container.querySelector("#sideP") as HTMLElement)
        .getByRole("button", { name: "Subagents 1" })
        .click(),
    );
    expect(container.querySelector("#sideBody")?.textContent).toContain(SCRIPT);
    act(() =>
      within(container.querySelector("#sideP") as HTMLElement)
        .getByRole("button", { name: "Files 1" })
        .click(),
    );
    expect(container.querySelector("#sideBody")?.textContent).toContain(PAYLOAD);
    expect(container.querySelector("#sideBody")?.textContent).toContain(SCRIPT);
    expect(container.querySelector("img, script")).toBeNull();
  });

  it("comms: escalation titles and error text in Needs you, tool names, the threads' doing line", async () => {
    stubFetch({
      "/api/attention": [
        item({
          key: "esc:shop-app#4001",
          kind: "decision",
          text: PAYLOAD,
          url: "javascript:alert(4)",
        }),
        item({
          key: "stall:shop-app-ta:r-12",
          kind: "stalled",
          escalationId: null,
          tool: PAYLOAD,
          url: null,
        }),
        item({
          key: "err:shop-app-ta",
          kind: "error",
          escalationId: null,
          text: SCRIPT,
          url: null,
        }),
      ],
      "/api/crew": {
        rows: [crewRow({ hudState: "error", sourceError: PAYLOAD + SCRIPT })],
        firstRunToday: null,
      },
      "/api/config": CONFIG,
    });
    const { container } = render(<Comms item={null} />);
    await screen.findByText(PAYLOAD);
    await vi.waitFor(() => expect(container.textContent).toContain(PAYLOAD + SCRIPT));
    expect(container.textContent).toContain(SCRIPT);
    expect(container.querySelector("img, script")).toBeNull();
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    }
  });
});

describe("githubHref", () => {
  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://github.com/a/b",
    "https://github.com.evil.example/a",
    "https://evil.example/github.com",
    "https://user:pass@github.com/a",
    "//github.com/a",
    "/a/b",
    "",
  ])("refuses %j", (url) => {
    expect(githubHref(url)).toBeNull();
  });

  it("keeps an https://github.com link, normalised", () => {
    expect(githubHref("https://github.com/octo-org/shop-app/pull/1")).toBe(
      "https://github.com/octo-org/shop-app/pull/1",
    );
    expect(githubHref("https://GITHUB.com/a")).toBe("https://github.com/a");
  });
});
