import { describe, expect, it } from "vitest";
import { filterNeeds, isAlert, NO_FILTERS, orderNeeds } from "../src/needs/needsView.ts";
import { HOUR, item, NOW } from "./fixtures.ts";

const q = (key: string, over = {}) =>
  item({ key, kind: "question", text: `Text ${key}`, ticket: `r#${key}`, ...over });

describe("needsView", () => {
  it("tells a hub alert from a question", () => {
    expect(isAlert(q("a", { alert: true }))).toBe(true);
    expect(isAlert(q("b"))).toBe(false);
  });

  it("filters by repo, asker and text", () => {
    const xs = [
      q("a", { repoId: "r1", agentId: "x-1", text: "Pick a port" }),
      q("b", { repoId: "r2", agentId: "x-2", text: "Pick a colour" }),
    ];
    expect(filterNeeds(xs, { ...NO_FILTERS, repo: "r2" }).map((i) => i.key)).toEqual(["b"]);
    expect(filterNeeds(xs, { ...NO_FILTERS, asker: "x-1" }).map((i) => i.key)).toEqual(["a"]);
    expect(filterNeeds(xs, { ...NO_FILTERS, text: "PORT" }).map((i) => i.key)).toEqual(["a"]);
  });

  it("orders by default, oldest, newest and deadline", () => {
    const xs = [
      q("old", { at: NOW - 5 * HOUR, defaultDueAt: NOW + 3 * HOUR }),
      q("new", { at: NOW - HOUR, defaultDueAt: NOW + HOUR }),
      q("none", { at: NOW - 3 * HOUR }),
    ];
    const keys = (o: Parameters<typeof orderNeeds>[1]) => orderNeeds(xs, o).map((i) => i.key);
    expect(keys("default")).toEqual(["old", "none", "new"]);
    expect(keys("oldest")).toEqual(["old", "none", "new"]);
    expect(keys("newest")).toEqual(["new", "none", "old"]);
    expect(keys("deadline")).toEqual(["new", "old", "none"]);
  });
});
