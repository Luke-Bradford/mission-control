import { describe, expect, it } from "vitest";
import { filterNeeds, isAlert, NO_FILTERS, orderNeeds } from "../src/needs/needsView.ts";
import { briefLinks } from "../src/needs/pictures.ts";
import { askerIdOf, askerOf, titleOf } from "../src/needs/QuestionBand.tsx";
import { brief, HOUR, item, NOW } from "./fixtures.ts";

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

  describe("the server's question fields (#1785)", () => {
    const seatQ = (over = {}) =>
      item({
        key: "ask:9",
        kind: "question",
        agentId: "mc-dev-1",
        brief: brief({ for: "operator" }),
        ...over,
      });

    it("names the asker seat, not the hub or FLIGHT, and looks its call sign up by it", () => {
      const i = seatQ({ agentId: null, asker: "flight-1" });
      expect(askerIdOf(i)).toBe("flight-1");
      expect(askerOf(i, "FLIGHT")).toBe("FLIGHT");
      expect(askerOf(i)).toBe("flight-1");
    });

    it("falls back to the agent id when there is no asker", () => {
      const i = seatQ();
      expect(askerIdOf(i)).toBe("mc-dev-1");
      expect(askerOf(i)).toBe("mc-dev-1");
    });

    it("prefers the brief's own title", () => {
      const i = seatQ({ brief: brief({ for: "operator", title: "#12 Pick a preview port" }) });
      expect(titleOf(i)).toBe("Pick a preview port");
      expect(titleOf(seatQ())).toBe(seatQ().text);
    });

    it("lists the brief's links with the item's other links, once each", () => {
      const i = seatQ({
        brief: brief({
          for: "operator",
          links: [
            { label: "Design note", url: "https://example.com/note" },
            { label: "Same", url: "https://github.com/octo-org/shop-app/issues/4001" },
          ],
        }),
      });
      expect(briefLinks(i)).toEqual([
        { label: "Open on GitHub", url: "https://github.com/octo-org/shop-app/issues/4001" },
        { label: "Design note", url: "https://example.com/note" },
      ]);
    });
  });
});
