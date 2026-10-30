import { readFileSync } from "node:fs";
import { REVIEW_CHECK_IDS } from "@mc/core";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const ROLES = ["FAO", "GUIDO", "INCO", "RETRO", "FLIGHT"] as const;
const checklist = read(".claude/skills/hud-design/SKILL.md");

/** The checklist items under one `## <name>` heading. */
const itemsUnder = (name: string) => {
  const section = checklist.split(/^## /m).find((part) => part.startsWith(`${name}\n`)) ?? "";
  return section.split("\n").filter((line) => line.startsWith("- [ ]"));
};

it.each(ROLES)("%s points web work at the design system and the HUD checklist", (role) => {
  const text = read(`roles/${role}.md`);
  expect(text).toContain("docs/design/system.md");
  expect(text).toContain(".claude/skills/hud-design/SKILL.md");
});

it.each(ROLES)("every checklist section %s names exists and has items", (role) => {
  const named = [
    ...read(`roles/${role}.md`).matchAll(
      /the ((?:Plan|Build|Check|Review)(?: and (?:Plan|Build|Check|Review))?) items/g,
    ),
  ].flatMap((m) => (m[1] ?? "").split(" and "));
  expect(named.length).toBeGreaterThan(0);
  for (const name of named) expect(itemsUnder(name).length, name).toBeGreaterThan(0);
});

it("RETRO records the design check for web PRs", () => {
  expect(read("roles/RETRO.md")).toContain("`design` check");
});

it("every section the checklist cites is a heading of the design system", () => {
  const headings = [...read("docs/design/system.md").matchAll(/^## ([\d–]+)\./gm)].map((m) => m[1]);
  const cited = [...checklist.matchAll(/§([\d–]+)/g)].map((m) => m[1]);
  expect(cited.length).toBeGreaterThan(0);
  for (const ref of cited) expect(headings, `§${ref}`).toContain(ref);
});

it("the HUD checklist stays a one-minute read", () => {
  const body = checklist.slice(checklist.indexOf("# HUD design checklist"));
  expect(body).toMatch(/^# HUD design checklist/);
  const words = body.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
  expect(words.length).toBeLessThanOrEqual(300);
});

/** Sentences of a text, split on `.` and `;`. */
const sentences = (text: string) => text.split(/[.;]\s/);

it("RETRO tries to break each kind of change and renders screens itself", () => {
  const text = read("roles/RETRO.md");
  const section = text.split(/^## /m).find((part) => part.startsWith("Try to break it\n")) ?? "";
  for (const kind of ["Screens", "APIs", "Database", "Shared code", "Shared state"])
    expect(section, kind).toContain(`**${kind}`);
  expect(section).toContain("browser test");
  expect(section).toContain("could not run");
});

it("RETRO names only check ids report_findings accepts", () => {
  const section =
    read("roles/RETRO.md")
      .split(/^## /m)
      .find((part) => part.startsWith("Try to break it\n")) ?? "";
  const named = [...section.matchAll(/as `([a-z-]+)`/g)].map((m) => m[1]);
  expect(named.length).toBeGreaterThan(0);
  for (const id of named) expect(REVIEW_CHECK_IDS as readonly string[], id).toContain(id);
});

it.each(["roles/RETRO.md", "roles/INCO.md", ".claude/skills/hud-design/SKILL.md"])(
  "%s keeps rendering with the reviewer; a Controller check is for live data only",
  (path) => {
    for (const sentence of sentences(read(path).replace(/\s+/g, " ")))
      if (/render/i.test(sentence) && /Controller check/.test(sentence))
        expect(sentence).toMatch(/live/);
  },
);
