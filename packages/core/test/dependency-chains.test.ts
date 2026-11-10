import { describe, expect, it } from "vitest";
import { type DependencyEdge, type DependencyWork, dependencyChains } from "../src/index.ts";

const node = (ref: string, patch: Partial<DependencyWork> = {}): DependencyWork => ({
  ref,
  title: ref,
  state: "moving",
  reason: "In review",
  owner: "review",
  seatId: null,
  ...patch,
});
const edge = (from: string, to: string, since: number | null = null): DependencyEdge => ({
  from,
  to,
  kind: "depends",
  since,
});
const build = (work: DependencyWork[], edges: DependencyEdge[]) =>
  dependencyChains({ repoId: "mc", work, edges, now: 1000 });

describe("dependencyChains", () => {
  it("keeps both roots and names a dependent's other root", () => {
    const chains = build(
      [node("A"), node("B"), node("C")],
      [edge("C", "A", 100), edge("C", "B", 200)],
    );
    expect(chains.map((c) => c.root.ref)).toEqual(["A", "B"]);
    expect(chains[0]?.root.children[0]).toMatchObject({
      ref: "C",
      waitedMs: 900,
      alsoWaitsOn: ["B"],
    });
    expect(chains[1]?.root.children[0]?.alsoWaitsOn).toEqual(["A"]);
    expect(chains.map((c) => c.longestWaitMs)).toEqual([900, 800]);
    expect(chains[0]?.frees).toEqual([]);
    expect(chains[0]?.stillWaiting).toEqual(["C"]);
  });
  it("frees only immediate dependents whose final wait ends, not grandchildren", () => {
    const chains = build([node("A"), node("B"), node("C")], [edge("B", "A"), edge("C", "B")]);
    expect(chains).toHaveLength(1);
    expect(chains[0]?.root.children[0]?.children[0]?.ref).toBe("C");
    expect(chains[0]?.frees).toEqual(["B"]);
    expect(chains[0]?.stillWaiting).toEqual(["C"]);
  });
  it("reports every cycle member and terminates its tree", () => {
    const chains = build(
      [node("A"), node("B"), node("C")],
      [edge("A", "B"), edge("B", "A"), edge("C", "B")],
    );
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({
      state: "stuck",
      reason: "These tickets wait on each other: A, B.",
      frees: [],
      stillWaiting: ["B", "C"],
    });
    expect(chains[0]?.root.children[0]?.children[0]?.ref).toBe("C");
  });
  it("reports self cycles and cycles which also have an external blocker", () => {
    expect(build([node("A")], [edge("A", "A")])[0]?.state).toBe("stuck");
    const chains = build(
      [node("A"), node("B"), node("Z")],
      [edge("A", "B"), edge("B", "A"), edge("A", "Z")],
    );
    expect(chains.map((c) => c.root.ref)).toEqual(["A", "Z"]);
    expect(chains.every((c) => c.state === "stuck" && c.reason.includes("A, B"))).toBe(true);
    expect(chains.find((c) => c.root.ref === "Z")?.frees).toEqual([]);
  });
  it("keeps unread and untracked references unknown, with no invented age", () => {
    for (const ref of ["PR 99", "untracked#3"]) {
      const chains = build([node("A")], [edge("A", ref)]);
      expect(chains[0]).toMatchObject({
        root: { ref, title: null },
        state: "unknown",
        longestWaitMs: null,
      });
    }
  });
  it("provides all dependents for the web's five-row disclosure", () => {
    const refs = Array.from({ length: 12 }, (_, i) => `C${i}`);
    const chains = build(
      [node("A"), ...refs.map((r) => node(r))],
      refs.map((r) => edge(r, "A")),
    );
    expect(chains[0]?.root.children).toHaveLength(12);
    expect(chains[0]?.frees).toHaveLength(12);
  });
  it("sorts by longest wait, then stuck, then ref, with unknown ages last", () => {
    const work = [node("A"), node("B", { state: "stuck" }), node("C"), node("D"), node("E")];
    const chains = build(work, [
      edge("x", "A", 500),
      edge("y", "B", 500),
      edge("z", "C", 600),
      edge("w", "D"),
      edge("v", "E", 100),
    ]);
    expect(chains.map((c) => c.root.ref)).toEqual(["E", "B", "A", "C", "D"]);
  });
  it("deduplicates an identical wait and preserves the oldest observed start without mutating input", () => {
    const edges = [edge("B", "A", 300), edge("B", "A", 100)];
    const before = JSON.stringify(edges);
    const chains = build([node("A"), node("B")], edges);
    expect(chains[0]?.root.children).toHaveLength(1);
    expect(chains[0]?.longestWaitMs).toBe(900);
    expect(JSON.stringify(edges)).toBe(before);
  });
  it("renders a diamond once per root and counts its longest alternate wait", () => {
    const chains = build(
      ["A", "B", "C", "D"].map((r) => node(r)),
      [edge("B", "A", 900), edge("C", "A", 900), edge("D", "B", 800), edge("D", "C", 1)],
    );
    expect(chains[0]?.longestWaitMs).toBe(999);
    expect(JSON.stringify(chains[0]?.root).match(/"ref":"D"/g)).toHaveLength(1);
    expect(chains[0]?.stillWaiting).toEqual(["D"]);
  });
  it("omits unrelated work and preserves edge kinds and root ownership", () => {
    const e: DependencyEdge = { from: "B", to: "A", kind: "queue", since: 1200 };
    const chains = build(
      [
        node("A", { state: "with-you", owner: "operator", reason: "Held" }),
        node("B"),
        node("alone"),
      ],
      [e],
    );
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({ state: "with-you", owner: "operator", reason: "Held" });
    expect(chains[0]?.root.children[0]).toMatchObject({ edge: "queue", waitedMs: 0 });
  });
});
