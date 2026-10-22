import { describe, expect, it } from "vitest";
import { parseAutonomyQuestion } from "../src/sd32.ts";

// Ported from site-builder engine/tests/test_dashboard_state.py
// (TestParseAutonomyQuestion + TestParseNeedsYou.test_question_attached_when_a_valid_block_present).
const GOOD = {
  question: "Proceed with plan B?",
  recommendation: "adopt plan B",
  reasoning_quote: "A cannot satisfy the invariant",
  effort_sunk: "3 sessions",
  default_if_ignored: "stay on plan A",
  answers: ["plan B", "discuss", "stay"],
};

const comment = (body: unknown, createdAt: unknown) => ({ body, createdAt }) as never;
const fenced = (obj: unknown, lang = "autonomy-question", nl = "\n") =>
  `leading prose${nl}\`\`\`${lang}${nl}${JSON.stringify(obj)}${nl}\`\`\`${nl}`;
const parse = (c: unknown) => parseAutonomyQuestion(c as never);

describe("parseAutonomyQuestion", () => {
  it("valid block returns object", () => {
    expect(parse([comment(fenced(GOOD), "2026-07-03T00:00:00Z")])).toEqual(GOOD);
  });

  it("newest question comment wins", () => {
    const c = [
      comment(fenced({ ...GOOD, question: "OLD" }), "2026-07-01T00:00:00Z"),
      comment(fenced({ ...GOOD, question: "NEW" }), "2026-07-05T00:00:00Z"),
    ];
    expect(parse(c)?.question).toBe("NEW");
  });

  it("newest wins regardless of array order", () => {
    const c = [
      comment(fenced({ ...GOOD, question: "NEW" }), "2026-07-05T00:00:00Z"),
      comment(fenced({ ...GOOD, question: "OLD" }), "2026-07-01T00:00:00Z"),
    ];
    expect(parse(c)?.question).toBe("NEW");
  });

  it("later prose-only comment does not mask question", () => {
    const c = [
      comment(fenced(GOOD), "2026-07-01T00:00:00Z"),
      comment("no block here", "2026-07-09T00:00:00Z"),
    ];
    expect(parse(c)?.question).toBe(GOOD.question);
  });

  it("newest block malformed does not fall back to older", () => {
    const { answers: _a, ...bad } = GOOD;
    const c = [
      comment(fenced(GOOD), "2026-07-01T00:00:00Z"),
      comment(fenced(bad), "2026-07-05T00:00:00Z"),
    ];
    expect(parse(c)).toBeNull();
  });

  it("extra key rejected", () => {
    expect(parse([comment(fenced({ ...GOOD, sneaky: "x" }), "z")])).toBeNull();
  });

  it("missing key rejected", () => {
    const { recommendation: _r, ...obj } = GOOD;
    expect(parse([comment(fenced(obj), "z")])).toBeNull();
  });

  it("too many answers rejected", () => {
    expect(parse([comment(fenced({ ...GOOD, answers: ["a", "b", "c", "d"] }), "z")])).toBeNull();
  });

  it("empty answers rejected", () => {
    expect(parse([comment(fenced({ ...GOOD, answers: [] }), "z")])).toBeNull();
  });

  it("non-string answer rejected", () => {
    expect(parse([comment(fenced({ ...GOOD, answers: ["ok", 3] }), "z")])).toBeNull();
  });

  it("wrong type scalar rejected", () => {
    expect(parse([comment(fenced({ ...GOOD, question: 5 }), "z")])).toBeNull();
  });

  it("bad json rejected", () => {
    expect(parse([comment("```autonomy-question\n{not json}\n```", "z")])).toBeNull();
  });

  it("non-object json rejected", () => {
    expect(parse([comment("```autonomy-question\n[1,2]\n```", "z")])).toBeNull();
    expect(parse([comment("```autonomy-question\nnull\n```", "z")])).toBeNull();
  });

  it("no fence returns null", () => {
    expect(parse([comment("just a normal comment", "z")])).toBeNull();
  });

  it("CRLF and trailing-space info string", () => {
    const body = `x\r\n\`\`\`autonomy-question   \r\n${JSON.stringify(GOOD)}\r\n\`\`\`\r\n`;
    expect(parse([comment(body, "z")])).toEqual(GOOD);
  });

  it("total against bad input", () => {
    for (const bad of [null, [], "not a list", 42, [null], [{ body: 5 }], [{ createdAt: "z" }]]) {
      expect(parse(bad)).toBeNull();
    }
  });

  it("question attached when a valid block present (needs-you parity)", () => {
    const q = {
      question: "Ship it?",
      recommendation: "yes",
      reasoning_quote: "because",
      effort_sunk: "2 sessions",
      default_if_ignored: "hold",
      answers: ["yes", "no"],
    };
    const body = `prose\n\`\`\`autonomy-question\n${JSON.stringify(q)}\n\`\`\`\n`;
    const triaged = parse([comment(body, "2026-07-03T01:00:00Z")]);
    expect(triaged?.question).toBe("Ship it?");
    expect(triaged?.answers).toEqual(["yes", "no"]);
    expect(parse([comment("just chatter", "z")])).toBeNull();
  });

  it("takes the first block in a comment", () => {
    const body = `${fenced({ ...GOOD, question: "FIRST" })}\n${fenced({ ...GOOD, question: "SECOND" })}`;
    expect(parse([comment(body, "z")])?.question).toBe("FIRST");
  });
});
