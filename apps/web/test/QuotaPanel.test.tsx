import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuotaPanel } from "../src/overview/QuotaPanel.tsx";
import { quotaWindows } from "../src/quota.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, HOUR, limit5h, limit7d, NOW } from "./fixtures.ts";

const accounts = [
  { id: "claude-main", vendor: "claude" as const, alertAt: 70, stopAt: 80 },
  { id: "codex-main", vendor: "codex" as const, alertAt: 70, stopAt: 80 },
];

describe("Quota windows by vendor", () => {
  it("Claude has 5h and 7d, Codex only 7d", () => {
    expect(quotaWindows("claude")).toEqual(["5h", "7d"]);
    expect(quotaWindows("codex")).toEqual(["7d"]);
    expect(quotaWindows(undefined)).toEqual(["5h", "7d"]);
  });
});

describe("Quota panel", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows Claude at 5h and 7d and Codex at 7d only, each with its forecast", async () => {
    stubFetch({
      "/api/config": { ...CONFIG, accounts },
      "/api/limits": [
        limit5h({ accountId: "claude-main", used: 41 }),
        limit7d({ accountId: "claude-main", used: 63, fullAt: NOW + 50 * HOUR }),
        limit7d({ accountId: "codex-main", used: 12 }),
        // A 5h reading for Codex is not shown.
        limit5h({ accountId: "codex-main", used: 99 }),
      ],
      "/api/health": [],
    });
    const { container } = render(<QuotaPanel />);
    await waitFor(() => expect(container.querySelectorAll(".quotarow")).toHaveLength(2));
    const [claude, codex] = [...container.querySelectorAll<HTMLElement>(".quotarow")];
    expect(within(claude as HTMLElement).getByText(/5h 41%/)).toBeTruthy();
    expect(
      within(claude as HTMLElement).getByText(/7d 63% · full in ~2d at this rate/),
    ).toBeTruthy();
    expect(within(codex as HTMLElement).getByText(/7d 12%/)).toBeTruthy();
    expect(codex?.textContent).not.toContain("5h");
    expect(codex?.textContent).not.toContain("99%");
    expect(screen.queryByText(/No data/i)).toBeNull();
  });

  it("a Codex account with no 7d reading says so in words", async () => {
    stubFetch({
      "/api/config": { ...CONFIG, accounts },
      "/api/limits": [],
      "/api/health": [],
    });
    const { container } = render(<QuotaPanel />);
    await waitFor(() => expect(container.querySelectorAll(".quotarow")).toHaveLength(2));
    const codex = container.querySelectorAll<HTMLElement>(".quotarow")[1] as HTMLElement;
    expect(codex.textContent).toMatch(/7d/);
    expect(codex.textContent).not.toMatch(/5h/);
  });
});
