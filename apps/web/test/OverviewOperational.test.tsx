import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { expect, it, vi } from "vitest";
import { MachinePanel } from "../src/overview/MachinePanel.tsx";
import { type EvidenceReader, OverviewEvidence } from "../src/overview/OverviewEvidence.tsx";
import { ContextSummaryPanel } from "../src/overview/OverviewInvestigation.tsx";
import { QuotaSummaryPanel } from "../src/overview/QuotaSummaryPanel.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, limit5h, limit7d, NOW, OVERVIEW, seatRow } from "./fixtures.ts";
import { observedContextDigest } from "./overviewDensityFixtures.ts";

it("summarizes the binding recorded allowance without presenting unknown windows as spare capacity", async () => {
  stubFetch({
    "/api/config": {
      ...CONFIG,
      accounts: [
        { id: "claude-main", vendor: "claude", alertAt: 70, stopAt: 80 },
        { id: "codex-main", vendor: "codex", alertAt: 70, stopAt: 80 },
      ],
    },
    "/api/limits": [
      limit5h({ accountId: "claude-main", used: 41 }),
      limit7d({ accountId: "claude-main", used: 63 }),
    ],
    "/api/health": [],
    "/api/limits/github": null,
  });
  render(<QuotaSummaryPanel />);
  const tightest = await screen.findByText("claude-main · 7d");
  expect(tightest.closest(".quota-summary-row")?.textContent).toContain("37% left");
  expect(screen.queryByText("59% left")).toBeNull();
  const unknown = screen.getByText(/codex-main · window unknown/).closest(".quota-summary-row");
  expect(unknown?.textContent).toContain("unknown");
  expect(unknown?.textContent).toContain("— remaining");
  expect(screen.getByText(/Tightest recorded window per account/)).toBeTruthy();
});

it("counts measured and unknown seat context independently of provider allowance", async () => {
  stubFetch({
    "/api/config": CONFIG,
    "/api/crew?shape=summary": {
      rows: [
        seatRow({
          id: "known",
          contextWindow: 200000,
          digest: observedContextDigest(180000, 200000),
        }),
        seatRow({ id: "unknown", digest: null, contextWindow: null }),
        seatRow({ id: "observed-loop", kind: "loop", digest: null, contextWindow: null }),
      ],
    },
  });
  render(<ContextSummaryPanel />);
  await screen.findByText("1 of 2 seats measured · 1 unknown window");
  expect(screen.getByText("1 at or above 80% used.")).toBeTruthy();
});

it("leaves complete evidence unmounted until requested and preserves it after closing", async () => {
  const originalShow = HTMLDialogElement.prototype.showModal,
    originalClose = HTMLDialogElement.prototype.close;
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  try {
    const ref = createRef<EvidenceReader>();
    const view = render(
      <>
        <button type="button" onClick={() => ref.current?.show()}>
          Inspect complete evidence
        </button>
        <OverviewEvidence ref={ref} title="Recorded evidence">
          <input aria-label="Retained reader draft" defaultValue="original" />
        </OverviewEvidence>
      </>,
    );
    expect(screen.queryByLabelText("Retained reader draft")).toBeNull();
    fireEvent.click(screen.getByText("Inspect complete evidence"));
    const draft = await screen.findByLabelText("Retained reader draft");
    fireEvent.change(draft, { target: { value: "preserved" } });
    fireEvent.click(screen.getByText("Close"));
    fireEvent.click(screen.getByText("Inspect complete evidence"));
    expect((screen.getByLabelText("Retained reader draft") as HTMLInputElement).value).toBe(
      "preserved",
    );
    view.unmount();
  } finally {
    HTMLDialogElement.prototype.showModal = originalShow;
    HTMLDialogElement.prototype.close = originalClose;
  }
});

it("preserves a new focus choice after reader close while restoring genuinely lost focus", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  const show = HTMLDialogElement.prototype.showModal,
    close = HTMLDialogElement.prototype.close;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  try {
    const ref = createRef<EvidenceReader>();
    render(
      <>
        <button type="button" onClick={() => ref.current?.show()}>
          Inspect focus evidence
        </button>
        <button type="button">Next legitimate control</button>
        <OverviewEvidence ref={ref} title="Focus evidence">
          <p>Existing evidence</p>
        </OverviewEvidence>
      </>,
    );
    const opener = screen.getByText("Inspect focus evidence"),
      next = screen.getByText("Next legitimate control");
    const flush = () =>
      act(() => {
        for (const callback of frames.splice(0)) callback(performance.now());
      });
    opener.focus();
    fireEvent.click(opener);
    const closeButton = screen.getByText("Close");
    closeButton.focus();
    fireEvent.click(closeButton);
    next.focus(); // User intent arrives after native close but before queued fallback restoration.
    flush();
    expect(document.activeElement).toBe(next);
    opener.focus();
    fireEvent.click(opener);
    closeButton.focus();
    fireEvent.click(closeButton);
    flush(); // A control left inside the closed native reader is genuinely lost.
    expect(document.activeElement).toBe(opener);
  } finally {
    HTMLDialogElement.prototype.showModal = show;
    HTMLDialogElement.prototype.close = close;
    vi.unstubAllGlobals();
  }
});

it("keeps compact machine histories honest and exposes complete transcript details", async () => {
  const source = stubFetch({
    "/api/config": CONFIG,
    "/api/overview": {
      ...OVERVIEW,
      machine: { cpu: [0, null, 20], mem: [25, 30, 32], disk: [410, null, 400] },
    },
    "/api/machine": {
      latest: null,
      warning: "Measured memory pressure",
      seats: 2,
      maxSeats: 4,
      perSessionMax: 2,
      transcripts: {
        totalBytes: 2048,
        oldestAt: NOW - 60000,
        seats: [{ seatId: "dev-1", bytes: 2048, files: 3 }],
      },
    },
    "/api/test-lock": { holder: null, waiting: [] },
  });
  const view = render(<MachinePanel compact />);
  await screen.findByRole("img", { name: "Disk free history" });
  expect(screen.getByText("Holding new work · Measured memory pressure")).toBeTruthy();
  expect(screen.getByText(/Test lock: free/)).toBeTruthy();
  expect(screen.queryByText("History not collected")).toBeNull();
  const graph = screen.getByRole("img", { name: "CPU % history" });
  expect(graph.querySelector('path[fill="none"]')?.getAttribute("d")?.match(/M/g)).toHaveLength(2);
  const before = source.mock.calls.length;
  view.rerender(
    <>
      <MachinePanel compact />
      <MachinePanel />
    </>,
  );
  await screen.findByText("Transcript footprint by seat");
  const table = screen.getByText("Transcript footprint by seat").parentElement;
  expect(table && within(table).getByText("dev-1")).toBeTruthy();
  const requested = source.mock.calls.slice(before).map(([path]) => String(path));
  expect(requested).not.toContain("/api/machine");
  expect(requested).not.toContain("/api/overview");
  expect([...new Set(requested)]).toEqual(["/api/crew?shape=summary"]);
});

it("keeps an unreported machine slot capacity unknown rather than a blank or zero count", async () => {
  stubFetch({
    "/api/config": CONFIG,
    "/api/overview": OVERVIEW,
    "/api/machine": { latest: null },
    "/api/test-lock": { holder: null, waiting: [] },
  });
  const view = render(<MachinePanel compact />);
  await screen.findByText("Slot capacity unknown");
  expect(view.container.textContent).not.toContain("undefined");
  expect(view.container.textContent).not.toContain("0 / 0 configured slots");
});
