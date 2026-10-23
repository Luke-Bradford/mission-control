import { type ConfigProfile, ENGINE_NOT_RUNNING, RETRY_NOTE } from "@mc/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Loops } from "../src/setup/Loops.tsx";
import { CONFIG } from "./fixtures.ts";

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

afterEach(cleanup);

const steps = (region: HTMLElement): (string | null)[] =>
  within(within(region).getByRole("list", { name: "Steps" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("Setup › Loops templates", () => {
  it("the Templates panel lists the profiles and draws the first one's steps", () => {
    render(<Loops config={cfg} />);
    const t = screen.getByRole("region", { name: "Templates" });
    const buttons = within(t).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "feature · label type:feature, or any other ticket with no template label · 6 steps",
      "small-change · label chore or test or docs, or Size XS or S with no template label · 4 steps",
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
      ENGINE_NOT_RUNNING,
    );
  });
});
