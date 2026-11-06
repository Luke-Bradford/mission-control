import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pages load lazily, and so does their CSS. Once a page's stylesheet has loaded it stays loaded, so
 * a class that one area defines at the top level of a rule also styles every other area that uses
 * the same class name. On 6 Nov the Overview's `.needs-row` (a three-column grid with a 64 px first
 * column) reached the Needs you list once the operator had opened the Overview first, and squeezed
 * each row's kind and age into 64 px over its title. Tests and reviews opened /needs-you directly, so
 * none of them saw it.
 *
 * An area is the first directory under `apps/web/src` (`root` for files directly in it). A class may
 * lead a selector in one area only. Scope a page's rules under its root (`#page-x .row`) or name the
 * class for its area.
 */
const SRC = join(import.meta.dirname, "../src");

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? cssFiles(join(dir, e.name))
      : e.name.endsWith(".css")
        ? [join(dir, e.name)]
        : [],
  );
}

const areaOf = (file: string): string => {
  const parts = relative(SRC, file).split(sep);
  return parts.length > 1 ? (parts[0] ?? "root") : "root";
};

/** The class each selector starts with, for every rule outside at-rule preludes. */
function leadClasses(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const m of text.matchAll(/([^{};]+)\{/g)) {
    const prelude = (m[1] ?? "").trim();
    if (prelude.startsWith("@")) continue;
    for (const selector of prelude.split(",")) {
      const lead = /^\.([A-Za-z][\w-]*)/.exec(selector.trim());
      if (lead?.[1]) out.push(lead[1]);
    }
  }
  return out;
}

function collisions(): Record<string, string[]> {
  const areas = new Map<string, Set<string>>();
  for (const file of cssFiles(SRC)) {
    for (const cls of leadClasses(readFileSync(file, "utf8"))) {
      const set = areas.get(cls) ?? new Set<string>();
      set.add(areaOf(file));
      areas.set(cls, set);
    }
  }
  return Object.fromEntries(
    [...areas]
      .filter(([, set]) => set.size > 1)
      .map(([cls, set]) => [cls, [...set].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Collisions that predate this test. Each is a cross-page leak waiting to happen. Remove an entry
 * when you fix it; the test fails until you do, so this list only shrinks.
 */
const KNOWN: Record<string, string[]> = {
  ahead: ["agent", "hud"],
  app: ["hud", "root"],
  arow: ["hud", "overview"],
  btitle: ["components", "hud"],
  chart: ["hud", "telemetry"],
  dmsg: ["components", "hud"],
  dock: ["hud", "root", "shell"],
  ev: ["agent", "hud"],
  "flight-crew": ["flight", "instructions"],
  "flight-knows-orders": ["flight", "instructions"],
  hrow: ["hud", "telemetry"],
  modal: ["hud", "shell"],
  msg: ["agent", "comms", "hud"],
  note: ["hud", "root"],
  nrow: ["flight", "hud"],
  opt: ["comms", "hud"],
  panel: ["hud", "root"],
  pb: ["components", "root"],
  ph: ["hud", "overview", "root"],
  "setup-repos": ["hud", "setup"],
  side: ["agent", "hud"],
  stat2: ["hud", "telemetry"],
  tiles: ["hud", "setup"],
};

describe("CSS class collisions between areas", () => {
  it("no class leads a rule in two areas, beyond the known list", () => {
    const found = collisions();
    const added = Object.keys(found).filter(
      (cls) => JSON.stringify(found[cls]) !== JSON.stringify(KNOWN[cls]),
    );
    const fixed = Object.keys(KNOWN).filter((cls) => !(cls in found));
    expect(
      added.map((cls) => `.${cls} in ${found[cls]?.join(", ")}`),
      "scope the rule under its page root, or rename the class for its area",
    ).toEqual([]);
    expect(fixed, "fixed: remove these from KNOWN").toEqual([]);
  });

  it("finds a collision in a sample", () => {
    expect(
      leadClasses(".a, #p .b { x: 1 }\n@media (x) { .c:hover { y: 2 } }\n/* .d {} */"),
    ).toEqual(["a", "c"]);
  });
});
