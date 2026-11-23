import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROLES = ["FAO", "GUIDO", "INCO"];
const root = join(process.cwd(), "roles");

describe("shared role prompts", () => {
  it.each(ROLES)("%s names no fixed FLIGHT seat id", (role) => {
    const text = readFileSync(join(root, `${role}.md`), "utf8");
    expect(text).not.toMatch(/\bflight-\d+\b/);
  });
});
