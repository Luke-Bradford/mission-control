import { cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CrewOverflowNote } from "../src/overview/CrewOverflowNote.tsx";

afterEach(cleanup);

/** The note renders before the table, as in the Crew panel. */
function Panel({ scrollWidth, pending }: { scrollWidth: number; pending: boolean }) {
  const table = useRef<HTMLDivElement>(null);
  return (
    <>
      <CrewOverflowNote id="hint" table={table} count={3} pending={pending} />
      <div
        id="agentsList"
        ref={(el) => {
          table.current = el;
          if (el) {
            Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
            Object.defineProperty(el, "clientWidth", { configurable: true, value: 482 });
          }
        }}
      />
    </>
  );
}

describe("Crew overflow note", () => {
  it("says the table scrolls sideways when it mounts with its data already loaded", async () => {
    const { container } = render(<Panel scrollWidth={740} pending={false} />);
    const note = container.querySelector<HTMLElement>("#hint");
    await waitFor(() => expect(note?.textContent).toContain("Scroll ↔"));
    expect(note?.hidden).toBe(false);
  });

  it("stays quiet when every column fits", () => {
    const { container } = render(<Panel scrollWidth={482} pending={false} />);
    const note = container.querySelector<HTMLElement>("#hint");
    expect(note?.textContent).toBe("");
    expect(note?.hidden).toBe(true);
  });
});
