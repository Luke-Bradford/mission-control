import { expect, it } from "vitest";
import { readStyle, readStyles } from "./styles.ts";

const css = readStyles();
const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";

it("fits measured attempts and long live task text into narrow panels", () => {
  expect(rule(".att")).toContain("grid-template-columns: 56px minmax(0, 1fr) auto 34px;");
  expect(rule("#sideBody .check > :last-child")).toContain("overflow-wrap: anywhere;");
  expect(rule(".check")).toContain("grid-template-columns: 70px minmax(0, 1fr);");
  expect(rule(".f")).toContain("grid-template-columns: minmax(0, 1fr) auto auto;");
  expect(rule(".ph")).toContain("flex-wrap: wrap;");
  expect(rule(".seg")).toContain("flex-wrap: wrap;");
  const narrow = readStyle("agent/agent.css").split("@media (max-width: 999px) {")[1] ?? "";
  expect(narrow).toMatch(/\.agrid \{\s+grid-template-columns: minmax\(0, 1fr\);/);
});

it("holds the rename form to its row and wraps long call signs within narrow headers", () => {
  // a grouped form (components/forms.css): one row of its own, never wider than its parent
  expect(rule(".rename-editor")).toContain("flex-basis: 100%;");
  expect(rule(".rename-editor")).toContain("min-width: 0;");
  expect(rule(".rename-editor")).toContain("overflow-wrap: anywhere;");
  expect(rule(".idrow .big")).toContain("overflow-wrap: anywhere;");
});
