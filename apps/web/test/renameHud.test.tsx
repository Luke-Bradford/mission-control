import { act, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { hub, RESOURCES } from "../src/data.ts";
import { Decided } from "../src/flight/Decided.tsx";
import { LockBox } from "../src/overview/LockBox.tsx";
import { Telemetry } from "../src/pages/Telemetry.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, seatRow } from "./fixtures.ts";

for (const display of ["lock box", "Telemetry lock row", "Decided without you"]) {
  it(`updates ${display} after a rename`, async () => {
    let row = seatRow({ id: "guido-1" });
    const now = Date.now();
    const fetch = stubFetch({
      "/api/config": CONFIG,
      "/api/crew": { rows: [row], firstRunToday: null },
      "/api/test-lock": {
        holder: { runId: "r", seatId: row.id, command: "pnpm test", since: now },
        waiting: [{ runId: "w", seatId: row.id, command: "pnpm test", since: now }],
      },
      "/api/flight": {
        seat: { id: "flight-1", live: true },
        decisions: [
          {
            id: 1,
            at: now,
            seatId: row.id,
            kind: "answer",
            about: "question",
            decision: "yes",
            basis: "because",
          },
        ],
      },
    });
    const answer = fetch.getMockImplementation();
    if (!answer) throw new Error("Missing fetch stub");
    fetch.mockImplementation(async (...args) =>
      args[0] === "/api/crew"
        ? new Response(JSON.stringify({ rows: [row], firstRunToday: null }))
        : answer(...args),
    );
    const { container } = render(
      display === "lock box" ? (
        <LockBox />
      ) : display === "Telemetry lock row" ? (
        <Telemetry />
      ) : (
        <Decided />
      ),
    );
    await screen.findAllByText(/guido-1/i);
    row = { ...row, displayCallSign: "ORBIT" };
    act(() => hub.refetch(RESOURCES.crew.path));
    if (display === "lock box") {
      await screen.findByRole("button", { name: "Open ORBIT" });
    } else if (display === "Telemetry lock row") {
      const panel = container.querySelector("#tLock") as HTMLElement;
      await within(panel).findByText(/ORBIT.*waiting/);
      expect(within(panel).getByRole("cell", { name: "ORBIT" })).toBeTruthy();
    } else {
      await within(screen.getByTestId("decided-row")).findByText("ORBIT");
    }
  });
}
