import { expect, it } from "vitest";
import { readStyle, readStyles } from "./styles.ts";

const css = readStyles();
const rule = (selector: string) => css.match(new RegExp(`\\n${selector} \\{([^}]*)\\}`))?.[1] ?? "";
const stacked =
  readStyle("pages/audit.css").match(/@media \(max-width: 1199px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";

it("lays Audit out as one screen: the list on the left, the evidence panels on the right", () => {
  expect(rule(".audit-cols")).toContain(
    "grid-template-columns: minmax(0, 1fr) var(--audit-side, 600px)",
  );
  expect(rule(".audit-page")).toContain("grid-template-rows: auto minmax(0, 1fr)");
  expect(rule(".audit-scroll")).toContain("overflow-y: auto");
});

it("stacks the columns on a narrow window", () => {
  expect(stacked).toContain(".audit-cols");
  expect(stacked).toContain("grid-template-columns: minmax(0, 1fr)");
});
