import type { PullRequestView } from "@mc/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { QaReadiness } from "../src/pages/QaReadiness.tsx";
import { buildEntries } from "../src/palette/entries.ts";
import { checkedHead, QA_CHECKED_HEADS_KEY } from "../src/qa/checked.ts";
import { prVerdict } from "../src/qa/readiness.ts";
import { stubFetch } from "./fetchStub.ts";
import "../src/hud.css";

const pr = (overrides: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "mission-control",
  number: 987,
  title: "PR readiness",
  url: "https://github.com/Luke-Bradford/mission-control/pull/987",
  branch: "feature/987",
  ticket: "mission-control#987",
  state: "open",
  isDraft: false,
  review: "approved",
  ci: "passing",
  createdAt: 0,
  updatedAt: 0,
  mergedAt: null,
  headSha: "head-a",
  mergeable: "MERGEABLE",
  ...overrides,
});

describe("prVerdict", () => {
  it("calls an approved, green, mergeable PR ready", () => {
    expect(prVerdict(pr(), [])).toEqual({ tone: "ok", text: "Ready" });
  });

  it("waits for a named missing check", () => {
    expect(prVerdict(pr({ ci: "pending" }), [])).toEqual({
      tone: "warn",
      text: "Waiting on CI",
    });
  });

  it("waits while review findings are unavailable and when mergeability is unknown", () => {
    expect(prVerdict(pr(), [], false)).toEqual({
      tone: "warn",
      text: "Waiting on review evidence",
    });
    expect(prVerdict(pr({ mergeable: null }), [])).toEqual({
      tone: "warn",
      text: "Waiting on merge check",
    });
  });

  it("holds a PR with an unresolved important finding", () => {
    expect(
      prVerdict(pr(), [
        {
          reviewId: 1,
          authorRunId: "retro-cx/run",
          repoId: "mission-control",
          prNumber: 987,
          round: 1,
          reviewEndedAt: 0,
          pos: 0,
          severity: "Important",
          category: "correctness",
          file: "apps/web/src/App.tsx",
          line: 1,
          summary: "Missing guard",
          resolution: null,
          resolvedReviewId: null,
        },
      ]),
    ).toEqual({ tone: "crit", text: "Held: 1 open important finding" });
  });
});

describe("QaReadiness", () => {
  beforeEach(() => {
    hub.clear();
    localStorage.clear();
    stubFetch({
      "/api/repos": [{ id: "mission-control", name: "Mission Control" }],
      "/api/repos/mission-control/prs": [pr()],
      "/api/qa/ci-runs?days=90": { runs: [] },
      "/api/qa/findings?days=90": { findings: [] },
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("marks one head checked, undoes it, and tells the operator when the head changed", async () => {
    const { rerender } = render(<QaReadiness />);
    expect(await screen.findByText("Before/after evidence is not captured yet.")).toBeTruthy();
    expect(screen.getByText("Added or changed tests are not captured yet.")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "mission-control PR #987 files on GitHub" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark checked" }));
    expect(screen.getByText("Checked at this head.")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(QA_CHECKED_HEADS_KEY) ?? "{}")).toEqual({
      "mission-control:987": "head-a",
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo checked" }));
    expect(screen.getByRole("button", { name: "Mark checked" })).toBeTruthy();

    localStorage.setItem(QA_CHECKED_HEADS_KEY, JSON.stringify({ "mission-control:987": "head-a" }));
    stubFetch({
      "/api/repos": [{ id: "mission-control", name: "Mission Control" }],
      "/api/repos/mission-control/prs": [pr({ headSha: "head-b" })],
      "/api/qa/ci-runs?days=90": { runs: [] },
      "/api/qa/findings?days=90": { findings: [] },
    });
    hub.clear();
    rerender(<QaReadiness />);
    expect(await screen.findByText("Changed since your check: new head pushed.")).toBeTruthy();
  });

  it("agrees with the palette: its Mark checked shows on the card, its Undo clears it, a moved head offers Mark checked again", async () => {
    const paletteEntry = (open: PullRequestView) =>
      buildEntries({ prs: [open] }).filter((e) => e.group === "Action");
    const [mark] = paletteEntry(pr());
    expect(mark?.title).toBe("Mark mission-control PR 987 checked");
    await mark?.run();

    render(<QaReadiness />);
    expect(await screen.findByText("Checked at this head.")).toBeTruthy();
    const [undo] = paletteEntry(pr());
    expect(undo?.title).toBe("Undo checked on mission-control PR 987");
    await undo?.run();
    expect(checkedHead("mission-control", 987)).toBeNull();

    await mark?.run();
    expect(paletteEntry(pr({ headSha: "head-b" }))[0]?.title).toBe(
      "Mark mission-control PR 987 checked",
    );
    expect(paletteEntry(pr({ headSha: null }))).toEqual([]);
  });

  it("an open card follows the palette: Mark and Undo from the palette change it at once", async () => {
    render(<QaReadiness />);
    expect(await screen.findByRole("button", { name: "Mark checked" })).toBeTruthy();
    const entry = () => buildEntries({ prs: [pr()] }).find((e) => e.group === "Action");
    await act(async () => entry()?.run());
    expect(screen.getByText("Checked at this head.")).toBeTruthy();
    await act(async () => entry()?.run());
    expect(screen.getByRole("button", { name: "Mark checked" })).toBeTruthy();
    expect(screen.queryByText("Checked at this head.")).toBeNull();
  });

  it("shows current and old CI attempts plus finding severity and size evidence", async () => {
    hub.clear();
    stubFetch({
      "/api/repos": [{ id: "mission-control", name: "Mission Control" }],
      "/api/repos/mission-control/prs": [pr({ additions: 100, deletions: 20, changedFiles: 4 })],
      "/api/qa/ci-runs?days=90": {
        runs: [
          {
            repoId: "mission-control",
            prNumber: 987,
            sha: "head-a",
            name: "lint",
            attempt: 1,
            state: "passing",
          },
          {
            repoId: "mission-control",
            prNumber: 987,
            sha: "head-a",
            name: "unit",
            attempt: 2,
            state: "failing",
          },
          {
            repoId: "mission-control",
            prNumber: 987,
            sha: "head-a",
            name: "e2e",
            attempt: 1,
            state: "pending",
          },
          {
            repoId: "mission-control",
            prNumber: 987,
            sha: "old-head",
            name: "lint",
            attempt: 1,
            state: "passing",
          },
        ],
      },
      "/api/qa/findings?days=90": {
        findings: [
          {
            reviewId: 1,
            authorRunId: "retro",
            repoId: "mission-control",
            prNumber: 987,
            round: 1,
            reviewEndedAt: 0,
            pos: 0,
            severity: "Important",
            category: null,
            file: "a.ts",
            line: 1,
            summary: "open",
            resolution: null,
            resolvedReviewId: null,
          },
          {
            reviewId: 1,
            authorRunId: "retro",
            repoId: "mission-control",
            prNumber: 987,
            round: 1,
            reviewEndedAt: 0,
            pos: 1,
            severity: "Minor",
            category: null,
            file: "b.ts",
            line: 1,
            summary: "fixed",
            resolution: "fixed",
            resolvedReviewId: 2,
          },
        ],
      },
    });
    render(<QaReadiness />);
    expect(await screen.findByText("lint · try 1 · passing")).toBeTruthy();
    expect(screen.getByText("unit · try 2 · failing")).toBeTruthy();
    expect(screen.getByText("e2e · try 1 · pending")).toBeTruthy();
    expect(screen.getByText(/Older heads: lint · old-hea · passing/)).toBeTruthy();
    expect(screen.getByText("Open by severity: Important 1")).toBeTruthy();
    expect(screen.getByText("Resolved by severity: Minor 1")).toBeTruthy();
    expect(screen.getByText("120 lines · 4 files")).toBeTruthy();
    expect(screen.getByText("Held: 1 open important finding")).toBeTruthy();
  });

  it.each([
    [1, 0, 1, "1 line · 1 file"],
    [60, 40, 2, "100 lines · 2 files"],
  ])(
    "sizes a PR in the right singular or plural: +%s -%s over %s files",
    async (additions, deletions, changedFiles, text) => {
      hub.clear();
      stubFetch({
        "/api/repos": [{ id: "mission-control", name: "Mission Control" }],
        "/api/repos/mission-control/prs": [pr({ additions, deletions, changedFiles })],
        "/api/qa/ci-runs?days=90": { runs: [] },
        "/api/qa/findings?days=90": { findings: [] },
      });
      render(<QaReadiness />);
      expect(await screen.findByText(text)).toBeTruthy();
    },
  );

  it("uses explicit error and empty states, and fails closed without findings", async () => {
    hub.clear();
    stubFetch({
      "/api/repos": [{ id: "mission-control", name: "Mission Control" }],
      "/api/repos/mission-control/prs": [pr()],
      "/api/qa/ci-runs?days=90": { runs: [] },
      "/api/qa/findings?days=90": () => ({ status: 500, body: { error: "findings down" } }),
    });
    const { unmount } = render(<QaReadiness />);
    expect(await screen.findByText("Waiting on review evidence")).toBeTruthy();
    unmount();

    hub.clear();
    stubFetch({
      "/api/repos": [{ id: "mission-control", name: "Mission Control" }],
      "/api/repos/mission-control/prs": [],
      "/api/qa/ci-runs?days=90": { runs: [] },
      "/api/qa/findings?days=90": { findings: [] },
    });
    render(<QaReadiness />);
    expect(await screen.findByText("No open pull requests to check.")).toBeTruthy();
  });

  it("does not present a repository failure as an empty board", async () => {
    hub.clear();
    stubFetch({
      "/api/repos": () => ({ status: 500, body: { error: "repositories down" } }),
      "/api/qa/ci-runs?days=90": { runs: [] },
      "/api/qa/findings?days=90": { findings: [] },
    });
    render(<QaReadiness />);
    expect(
      await screen.findByText("Could not load open pull requests: repositories down"),
    ).toBeTruthy();
    expect(screen.queryByText("No open pull requests to check.")).toBeNull();
  });
});
