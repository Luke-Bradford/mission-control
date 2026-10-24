import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ConfigProfile, type Crew, type CrewLoop, RETRY_NOTE } from "@mc/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Loops } from "../src/setup/Loops.tsx";
import { setSession } from "../src/shell/session.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { settled, stubFetch } from "./fetchStub.ts";
import { CONFIG, seatRow } from "./fixtures.ts";

const TEMPLATES: ConfigProfile[] = [
  {
    name: "feature",
    labels: ["type:feature"],
    steps: [
      { name: "plan", phase: null },
      { name: "go/no-go", phase: null },
      { name: "implement", phase: "working" },
      { name: "verify", phase: "ci" },
      { name: "review", phase: "review" },
      { name: "draft PR", phase: null },
    ],
    planRequired: true,
    reviewer: { role: "RETRO", depth: "full" },
    tries: 3,
    rounds: 3,
  },
  {
    name: "small-change",
    labels: ["chore", "test", "docs"],
    steps: [
      { name: "implement", phase: "working" },
      { name: "verify", phase: "ci" },
      { name: "review", phase: "review" },
      { name: "draft PR", phase: null },
    ],
    planRequired: false,
    reviewer: { role: "RETRO", depth: "light" },
    tries: 2,
    rounds: 2,
  },
];

const cfg = { ...CONFIG, profiles: { source: "built-in", error: null, list: TEMPLATES } };

beforeEach(() => stubFetch({ "/api/crew": { rows: [], firstRunToday: null } }));
afterEach(cleanup);

const steps = (region: HTMLElement): (string | null)[] =>
  within(within(region).getByRole("list", { name: "Steps" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("Setup › Loops templates", () => {
  it("template rows wrap within their width (hud.css)", () => {
    const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
    const rule = (selector: string) =>
      css.match(new RegExp(`${selector} \\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule(String.raw`\.loop-templates > li`)).toContain("min-width: 0;");
    const button = rule(String.raw`\.loop-templates > li > button`);
    expect(button).toContain("min-width: 0;");
    expect(button).toContain("max-width: 100%;");
    expect(button).toContain("white-space: normal;");
    expect(button).toContain("overflow-wrap: anywhere;");
  });

  it("the Templates panel lists the profiles and draws the first one's steps", () => {
    render(<Loops config={cfg} />);
    const t = screen.getByRole("region", { name: "Templates" });
    const buttons = within(within(t).getByRole("list")).getAllByRole("button");
    expect(within(t).getByRole("list").classList.contains("loop-templates")).toBe(true);
    expect(buttons.map((b) => b.textContent)).toEqual([
      "feature · label type:feature, or any other ticket with no template label · — running · 6 steps",
      "small-change · label chore or test or docs, or Size XS or S with no template label · — running · 4 steps",
    ]);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    const f = screen.getByRole("region", { name: "feature" });
    expect(steps(f)).toEqual([
      "1 plan",
      "2 go/no-go",
      "3 implement",
      "4 verify",
      "5 review",
      "6 draft PR",
    ]);
    expect(f.textContent).toContain("Up to 3 rounds · Plan required before a developer starts");
    expect(f.textContent).toContain("Up to 3 tries.");
    expect(f.textContent).toContain("RETRO, fresh eyes · full review");
    expect(f.textContent).toContain(RETRY_NOTE);
  });

  it.each([cfg, CONFIG])(
    "New explains how to define a template, including without profiles",
    (config) => {
      render(
        <>
          <Loops config={config} />
          <Toast />
        </>,
      );
      fireEvent.click(
        within(screen.getByRole("region", { name: "Templates" })).getByRole("button", {
          name: "New",
        }),
      );
      expect(screen.getByRole("status").textContent).toBe(
        "New template: name the work type, draw the steps, give each step its checks and a limit, then bind it to a ticket label.",
      );
    },
  );

  const loop: CrewLoop = {
    phase: "working",
    text: "Working",
    prNumber: null,
    parked: null,
    profile: "feature",
    step: "implement",
  };
  const crew: Crew = {
    firstRunToday: null,
    rows: [
      seatRow({ id: "inco-1", loop }),
      seatRow({ id: "guido-2", loop: { ...loop, phase: "ci", step: "verify" } }),
      seatRow({ id: "waiting-seat", hudState: "waiting", loop }),
      seatRow({ id: "idle-seat", hudState: "idle", loop }),
      seatRow({ id: "stopped-seat", hudState: "stopped", loop }),
      seatRow({ id: "other-profile", loop: { ...loop, profile: "small-change" } }),
      seatRow({ id: "no-loop", loop: null }),
    ],
  };

  it("counts running seats per template and lists current occupants only on their step as inert text", async () => {
    const unsafeId = "<img src=x onerror=alert(1)>";
    const fetchFn = stubFetch({
      "/api/crew": {
        ...crew,
        rows: crew.rows.map((r) => (r.id === "inco-1" ? { ...r, id: unsafeId } : r)),
      },
    });
    render(<Loops config={cfg} />);
    await settled(fetchFn, "/api/crew");
    expect(screen.getByRole("button", { name: /^feature/ }).textContent).toContain("2 running");
    expect(screen.getByRole("button", { name: /^small-change/ }).textContent).toContain(
      "1 running",
    );
    const card = screen.getByText("3 · implement").parentElement as HTMLElement;
    expect(within(card).getByText("on this step")).toBeTruthy();
    expect(within(card).getByText(unsafeId)).toBeTruthy();
    expect(within(card).getByText("waiting-seat")).toBeTruthy();
    expect(card.querySelector("img")).toBeNull();
    expect(card.textContent).not.toMatch(/guido-2|idle-seat|stopped-seat|other-profile|no-loop/);
    expect(screen.getByText("4 · verify").parentElement?.textContent).toContain("guido-2");
    fireEvent.click(screen.getByRole("button", { name: /^small-change/ }));
    expect(screen.getByText("1 · implement").parentElement?.textContent).toContain("other-profile");
    expect(screen.queryByText(unsafeId)).toBeNull();
  });

  // Sessions are crew sessions (#387); a repo id is not a session.
  it.each(["s1"])("filters template counts and occupants for %s", async (session) => {
    const fetchFn = stubFetch({
      "/api/crew": {
        ...crew,
        rows: [
          ...crew.rows,
          seatRow({ id: "elsewhere", repoId: "site-builder", sessionId: "s2", loop }),
        ],
      },
    });
    setSession(session);
    render(<Loops config={cfg} />);
    await settled(fetchFn, "/api/crew");
    expect(screen.getByRole("button", { name: /^feature/ }).textContent).toContain("2 running");
    expect(screen.queryByText("elsewhere")).toBeNull();
  });

  it("shows zero running after an empty crew loads", async () => {
    const fetchFn = stubFetch({ "/api/crew": { rows: [], firstRunToday: null } });
    render(<Loops config={cfg} />);
    await settled(fetchFn, "/api/crew");
    expect(screen.getByRole("button", { name: /^feature/ }).textContent).toContain("0 running");
  });

  it("picking a profile draws its steps", () => {
    render(<Loops config={cfg} />);
    fireEvent.click(screen.getByRole("button", { name: /^small-change/ }));
    const s = screen.getByRole("region", { name: "small-change" });
    expect(steps(s)).toEqual(["1 implement", "2 verify", "3 review", "4 draft PR"]);
    expect(s.textContent).toContain("Up to 2 rounds");
    expect(s.textContent).toContain("Up to 2 tries.");
    expect(s.textContent).toContain("RETRO, fresh eyes · light review");
    expect(s.textContent).not.toContain("Plan required");
    expect(screen.queryByRole("region", { name: "feature" })).toBeNull();
  });

  it("a profiles error says so; no profiles keeps the placeholder", () => {
    const { unmount } = render(
      <Loops config={{ ...CONFIG, profiles: { source: "x", error: "bad yaml", list: [] } }} />,
    );
    expect(screen.getByRole("region", { name: "Templates" }).textContent).toContain(
      "Could not read the template profiles: bad yaml",
    );
    unmount();
    render(<Loops config={CONFIG} />);
    expect(screen.getByRole("region", { name: "Templates" }).textContent).toContain(
      "This server reads no template profiles.",
    );
  });

  it("with no observed loops the panel says so and has no table", () => {
    render(<Loops config={{ ...cfg, loops: [] }} />);
    const panel = screen.getByRole("region", { name: "Observed loops" });
    expect(panel.textContent).toContain("No observed loops.");
    expect(within(panel).queryByRole("table")).toBeNull();
  });
});
