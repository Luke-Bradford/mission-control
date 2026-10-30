import type { PullRequestView } from "@mc/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { QaReadiness } from "../src/pages/QaReadiness.tsx";
import { QA_CHECKED_HEADS_KEY } from "../src/qa/checked.ts";
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
});
