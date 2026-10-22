import { describe, expect, it } from "vitest";
import {
  cutAtWord,
  LAST_TEXT_MAX,
  leadSentence,
  WORK_SUMMARY_MAX,
  workSummary,
} from "../src/summary.ts";

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** A cut text (its `…` dropped) that is nothing but whole "abcdef" words. */
const wholeWords = (s: string) =>
  s
    .slice(0, -1)
    .split(" ")
    .every((w) => w === "abcdef");

describe("workSummary", () => {
  it("skips a leading DONE marker in each form, any case, and capitalises what follows", () => {
    const rest = "the draft PR is #174 (Closes #167). `reconcile` is in place.";
    const leads = [
      "DONE. ",
      "DONE: ",
      "DONE — ",
      "done - ",
      "Done.\n",
      "DONE\n",
      "**DONE** ",
      "**DONE.** ",
      "# DONE\n",
      "## Done: ",
    ];
    for (const lead of leads) {
      expect(workSummary(`${lead}${rest}`)).toBe(
        "The draft PR is #174 (Closes #167). reconcile is in place.",
      );
    }
  });
  it("leaves text without a DONE marker alone, and keeps a word that merely starts with it", () => {
    expect(workSummary("Merged the fence.")).toBe("Merged the fence.");
    expect(workSummary("Done with the migration.")).toBe("Done with the migration.");
    expect(workSummary("Done-ish, but CI is red.")).toBe("Done-ish, but CI is red.");
    expect(workSummary("Condoned.")).toBe("Condoned.");
    expect(workSummary("reconcile is in place.")).toBe("reconcile is in place.");
  });
  it("strips Markdown markers, links and _italics_", () => {
    expect(workSummary("- **Added** `foo.ts`. Next one.")).toBe("Added foo.ts. Next one.");
    expect(workSummary("See [the PR](https://x.test/pull/1) for _all_ of it.")).toBe(
      "See the PR for all of it.",
    );
    expect(workSummary("Kept snake_case_names intact.")).toBe("Kept snake_case_names intact.");
  });
  it("leaves no orphan list number: a numbered list reads as its items", () => {
    const text =
      "DONE. The branch has 3 commits on top of main, with no amend or rebase.\n\n1. Added the column\n2. Wired the supervisor\n3) Tested it\n";
    expect(workSummary(text)).toBe(
      "The branch has 3 commits on top of main, with no amend or rebase. Added the column; Wired the supervisor; Tested it",
    );
  });
  it("strips the number of a bold numbered heading", () => {
    expect(workSummary("**1. Measured cost**\nIt was 3 cents.")).toBe(
      "Measured cost; It was 3 cents.",
    );
    expect(workSummary("- **2) Wired it** up.")).toBe("Wired it up.");
  });
  it("drops the contents of a code fence", () => {
    expect(workSummary("DONE.\n```\npnpm -s test\n```\nAll good.")).toBe("All good.");
    expect(leadSentence("```sh\nls -la\n```\nListed it. More.")).toBe("Listed it.");
  });
  it("keeps the case of a first token in backticks after DONE", () => {
    expect(workSummary("DONE. `pnpm -s test` passes.")).toBe("pnpm -s test passes.");
    expect(workSummary("DONE. - `reconcile` is in.")).toBe("reconcile is in.");
  });
  it("does not leave a heading dangling before the …", () => {
    // 7 sentences and the heading fill the cap; the next sentence does not fit.
    const filler = "A sentence of some length here. ".repeat(7);
    for (const heading of ["Critical", "Changes:", "Changes (3)", "**Important**"]) {
      const s = workSummary(`${filler}\n${heading}\n${filler}${filler}`) as string;
      expect(s.endsWith(".…")).toBe(true);
      expect(s).not.toMatch(/Critical|Changes|Important/);
    }
  });
  it("joins a colon-ended line to what follows with a space", () => {
    expect(workSummary("Changes:\n- Added a\n- Fixed b")).toBe("Changes: Added a; Fixed b");
  });
  it("drops table rows and separator rows", () => {
    const text = "DONE\n\n| Item | What I did |\n|---|---|\n| 1. | Fixed it |\n\nAll checks pass.";
    expect(workSummary(text)).toBe("All checks pass.");
  });
  it("joins lines without end punctuation with a semicolon", () => {
    expect(workSummary("## Summary\n- Added a\n- Fixed b")).toBe("Summary; Added a; Fixed b");
  });
  it("does not end a sentence at e.g. or i.e.", () => {
    expect(workSummary("Handles cases (e.g. a missing file, i.e. ENOENT) well. Next.")).toBe(
      "Handles cases (e.g. a missing file, i.e. ENOENT) well. Next.",
    );
    expect(leadSentence("Use a tool, e.g. Bash, here. More.")).toBe("Use a tool, e.g. Bash, here.");
  });
  it("keeps a period inside backticks and in version numbers", () => {
    expect(workSummary("Bumped `v1.2. x` and more. Next")).toBe("Bumped v1.2. x and more. Next");
    expect(workSummary("Fixed v1.2.3 parsing. Next")).toBe("Fixed v1.2.3 parsing. Next");
    expect(workSummary("#1234 merged to main.")).toBe("#1234 merged to main.");
  });
  it("cuts a long reply at a sentence boundary within the cap", () => {
    const s = workSummary("A sentence of some length here. ".repeat(40)) as string;
    expect(WORK_SUMMARY_MAX).toBe(240);
    expect(s.length).toBeLessThanOrEqual(WORK_SUMMARY_MAX);
    expect(s.length).toBeGreaterThan(WORK_SUMMARY_MAX - 40);
    expect(s.endsWith(".…")).toBe(true);
  });
  it("cuts one long sentence at a word boundary, never mid-word", () => {
    // 6-letter words: the cap (239 characters before the …) falls inside a word.
    const s = workSummary(`${"abcdef ".repeat(100)}end.`) as string;
    expect(s.length).toBeLessThanOrEqual(WORK_SUMMARY_MAX);
    expect(s.endsWith("…")).toBe(true);
    expect(wholeWords(s)).toBe(true);
  });
  it("cuts a long unbroken string by code point, never leaving a lone surrogate", () => {
    const s = workSummary("😀".repeat(400)) as string;
    expect(Array.from(s).length).toBeLessThanOrEqual(WORK_SUMMARY_MAX);
    expect(LONE_SURROGATE.test(s)).toBe(false);
    expect(s.endsWith("😀…")).toBe(true);
  });
  it("is null when nothing is left", () => {
    expect(workSummary("DONE.")).toBeNull();
    expect(workSummary("  ")).toBeNull();
    expect(workSummary("|a|b|\n|-|-|")).toBeNull();
  });
});

describe("workSummary residuals", () => {
  it("keeps a year at the start of a line, but strips a list number", () => {
    expect(workSummary("2026. A year.")).toBe("2026. A year.");
    expect(workSummary("12. Item one.")).toBe("Item one.");
  });
  it("strips *italic*, __bold__ and task checkboxes", () => {
    expect(workSummary("This is *really* done. And __so__ is that.")).toBe(
      "This is really done. And so is that.",
    );
    expect(workSummary("- [x] Wrote the tests.\n- [ ] Ship it.")).toBe("Wrote the tests. Ship it.");
  });
  it("drops a pipe table row with no leading pipe", () => {
    expect(workSummary("a | b\n--|--\n1 | 2\nThe change is in.")).toBe("The change is in.");
  });
  it("skips DONE followed by a tick or a double dash", () => {
    expect(workSummary("DONE ✅ the PR is up.")).toBe("The PR is up.");
    expect(workSummary("DONE -- the PR is up.")).toBe("The PR is up.");
  });
  it("does not end a sentence at etc. before lowercase, or at Mr.", () => {
    expect(leadSentence("Fixed a, b, etc. in the parser. More.")).toBe(
      "Fixed a, b, etc. in the parser.",
    );
    expect(leadSentence("Mr. Smith asked. More.")).toBe("Mr. Smith asked.");
    expect(leadSentence("Fixed a, b, etc. Then more.")).toBe("Fixed a, b, etc.");
  });
});

describe("leadSentence", () => {
  it("is the first sentence, Markdown stripped, capped", () => {
    expect(LAST_TEXT_MAX).toBe(160);
    expect(leadSentence("Reading `a.ts` now. Then more.")).toBe("Reading a.ts now.");
    expect(leadSentence("")).toBeNull();
  });
  it("skips a DONE marker like the summary does", () => {
    expect(leadSentence("DONE. the checks pass. More.")).toBe("The checks pass.");
  });
  it("cuts at a word boundary", () => {
    const s = leadSentence(`${"abcdef ".repeat(80)}end.`) as string;
    expect(s.length).toBeLessThanOrEqual(LAST_TEXT_MAX);
    expect(wholeWords(s)).toBe(true);
  });
});

describe("cutAtWord", () => {
  it("leaves a short string alone and ends a cut one in … without a trailing space", () => {
    expect(cutAtWord("short", 10)).toBe("short");
    const s = cutAtWord("aaaa bbbb cccc", 10);
    expect(s).toBe("aaaa bbbb…");
    expect(cutAtWord("aaaa bbbb cccc", 9)).toBe("aaaa…");
    expect(cutAtWord("aaaa  bbbb cccc", 7)).toBe("aaaa…");
    expect(cutAtWord("aaaa, bbbb cccc", 8)).toBe("aaaa…");
  });
});
