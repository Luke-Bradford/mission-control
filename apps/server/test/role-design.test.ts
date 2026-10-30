import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

it.each(["FAO", "GUIDO", "INCO", "RETRO", "FLIGHT"])(
  "%s points web work at the design system and the HUD checklist",
  (role) => {
    const text = read(`roles/${role}.md`);
    expect(text).toContain("docs/design/system.md");
    expect(text).toContain(".claude/skills/hud-design/SKILL.md");
  },
);

it("RETRO records the design check for web PRs", () => {
  expect(read("roles/RETRO.md")).toContain("`design` check");
});

it("the HUD checklist stays a one-minute read", () => {
  const body = read(".claude/skills/hud-design/SKILL.md").split("---").slice(2).join("---");
  expect(body.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(300);
});
