import { describe, expect, it } from "vitest";
import { classifyMissed } from "../src/bug-escapes/classify.ts";

const covered = {
  hasReview: true,
  doneWhen: ["Totals include tax for every basket"],
  bugTitle: "Basket totals ignore tax",
  fixedFiles: ["src/price.ts"],
  introFiles: ["src/price.ts", "test/price.test.ts"],
};

describe("classifyMissed", () => {
  it("is none when the PR was reviewed, its ticket covered the case and a test sat beside the code", () => {
    expect(classifyMissed(covered)).toBe("none");
  });

  it("is review when the introducing PR had no hub review", () => {
    expect(classifyMissed({ ...covered, hasReview: false })).toBe("review");
  });

  it("is requirement when no done-when line shares a word with the bug", () => {
    expect(classifyMissed({ ...covered, doneWhen: ["Logo is blue"] })).toBe("requirement");
    expect(classifyMissed({ ...covered, doneWhen: [] })).toBe("requirement");
  });

  it("is test when reviewed but no test file matches a fixed file", () => {
    expect(classifyMissed({ ...covered, introFiles: ["src/price.ts"] })).toBe("test");
    expect(classifyMissed({ ...covered, introFiles: ["src/price.ts", "test/other.test.ts"] })).toBe(
      "test",
    );
  });

  it("names the earliest gap: review, then requirement, then test", () => {
    const none = { ...covered, hasReview: false, doneWhen: [], introFiles: [] };
    expect(classifyMissed(none)).toBe("review");
    expect(classifyMissed({ ...none, hasReview: true })).toBe("requirement");
    expect(classifyMissed({ ...none, hasReview: true, doneWhen: covered.doneWhen })).toBe("test");
  });
});
