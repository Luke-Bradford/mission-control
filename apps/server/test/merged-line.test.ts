import { flightMergedLine } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { recordExternalMerge, sendFlightMergedLine } from "../src/flight/merged-line.ts";
import { Store } from "../src/store.ts";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());
const config = { repos: [] } as unknown as CcConfig;
const rows = () => store.commsOnTicket("mc#9", "#9", ["PR 15"], 10);

describe("sendFlightMergedLine", () => {
  it("an external merge with a linked ticket sends one line linking its decision", () => {
    const ok = sendFlightMergedLine(
      { store, config, log: () => {} },
      {
        at: 1,
        pr: 15,
        reasons: ["touches .github/workflows/ci.yml"],
        ticket: { ref: "mc#9", repoId: "mc", issue: 9 },
        decision: { id: 4, basis: "Read the diff" },
      },
    );
    expect(ok).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      to: "CAPCOM",
      ref: "PR 15",
      label: null,
      text: flightMergedLine(15, ["touches .github/workflows/ci.yml"], "/tickets/mc/9#decision-4"),
    });
  });

  it("a ticketless line links /flight and ends with the basis, cut to 300 characters", () => {
    sendFlightMergedLine(
      { store, config, log: () => {} },
      {
        at: 1,
        pr: 15,
        reasons: ["touches CLAUDE.md"],
        ticket: null,
        decision: { id: 4, basis: "b".repeat(400) },
      },
    );
    const line = flightMergedLine(15, ["touches CLAUDE.md"], "/flight");
    const sent = store.commsOnTicket("", "#0", ["PR 15"], 10).find((m) => m.ref === "PR 15");
    expect(sent?.text).toBe(`${line} ${"b".repeat(300)}`);
  });

  it("recordExternalMerge gives the decision its ticket ref and links it in the line", () => {
    const seen: { ref: string | null }[] = [];
    const record = (d: { ref: string | null }) => {
      seen.push(d);
      return 77;
    };
    recordExternalMerge(
      { store, config, log: () => {}, record: record as never },
      {
        at: 1,
        pr: 15,
        repoId: "mc",
        text: "Merged",
        basis: "Read it",
        seatId: null,
        reasons: ["touches CLAUDE.md"],
        ticket: 9,
      },
    );
    expect(seen[0]?.ref).toBe("mc#9");
    expect(rows()[0]?.text).toContain("/tickets/mc/9#decision-77");
  });
});
