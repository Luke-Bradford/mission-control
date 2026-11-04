import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ContextCapacity, contextCapacity } from "../src/overview/ContextCapacity.tsx";
import { seatRow } from "./fixtures.ts";
import { observedContextDigest } from "./overviewDensityFixtures.ts";

afterEach(cleanup);
it("distinguishes reported context capacity from rate and allowance, including zero used", () => {
  const row = seatRow({
    digest: observedContextDigest(84000, 200000),
    contextWindow: 200_000,
  });
  expect(contextCapacity(row)).toEqual({
    used: 84000,
    window: 200000,
    remaining: 116000,
    over: 0,
    pct: 42,
  });
  const view = render(<ContextCapacity row={row} />);
  // used, limit and percent are three cells; what is left is in each one's hover
  expect([...view.container.children].map((cell) => cell.textContent)).toEqual([
    "84.0k",
    "200k",
    "42%",
  ]);
  expect(view.container.children[0]?.getAttribute("title")).toBe(
    "Last reported context: 84.0k used of 200k · 116k left",
  );
  expect(contextCapacity({ ...row, digest: observedContextDigest(0, 200000) }).remaining).toBe(
    200000,
  );
});
it("retains known numerator or denominator without manufacturing the missing capacity", () => {
  const row = seatRow({
    digest: observedContextDigest(84000, null),
    contextWindow: null,
  });
  expect(contextCapacity(row)).toMatchObject({
    used: 84000,
    window: null,
    remaining: null,
    pct: null,
  });
  const v = render(<ContextCapacity row={row} />);
  expect([...v.container.children].map((cell) => cell.textContent)).toEqual(["84.0k", "—", "—"]);
  expect(v.container.children[0]?.getAttribute("title")).toContain("limit unknown");
  v.rerender(<ContextCapacity row={{ ...row, digest: null, contextWindow: 200000 }} />);
  expect([...v.container.children].map((cell) => cell.textContent)).toEqual(["—", "200k", "—"]);
  expect(v.container.children[0]?.getAttribute("title")).toContain("remaining unknown");
});
it("names an over-window report rather than displaying negative tokens remaining", () => {
  const row = seatRow({
    digest: observedContextDigest(220000, 200000),
    contextWindow: 200000,
  });
  expect(contextCapacity(row)).toMatchObject({ remaining: 0, over: 20000, pct: 110 });
  const view = render(<ContextCapacity row={row} />);
  expect(view.container.children[0]?.getAttribute("title")).toContain("20.0k over");
  expect(view.container.textContent).not.toContain("-");
});
