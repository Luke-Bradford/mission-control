import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";

it("fits measured attempts and long live task text into narrow panels", () => {
  expect(rule(".att")).toContain("grid-template-columns: 56px minmax(0, 1fr) auto 34px;");
  expect(rule("#sideBody .check > :last-child")).toContain("overflow-wrap: anywhere;");
  expect(rule(".check")).toContain("grid-template-columns: 70px minmax(0, 1fr);");
  expect(rule(".f")).toContain("grid-template-columns: minmax(0, 1fr) auto auto;");
  expect(rule(".ph")).toContain("flex-wrap: wrap;");
  expect(rule(".seg")).toContain("flex-wrap: wrap;");
  const narrow = css.split("@media (max-width: 999px) {")[1] ?? "";
  expect(narrow).toMatch(/\.agrid,[^{]+\{\s+grid-template-columns: minmax\(0, 1fr\);/);
});
