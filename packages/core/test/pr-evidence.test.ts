import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_HEADING,
  EVIDENCE_PAGE_PATHS,
  type EvidenceManifest,
  evidenceImageName,
  evidenceMissing,
  evidenceRefusalText,
  evidenceReleaseTag,
  evidenceSectionText,
  evidenceUncataloguedText,
  evidenceVariants,
  HUD_PAGE_PATHS,
  isEvidenceImageName,
  prEvidenceAffectedPages,
  prEvidenceUncatalogued,
  sectionOf,
  withSection,
} from "../src/index.ts";

const ALL = [
  ...Object.keys(HUD_PAGE_PATHS),
  "setup_repos",
  "setup_loops",
  "setup_accounts",
  "setup_roles",
  "setup_sources",
  "setup_access",
  "telemetry_cost",
  "telemetry_throughput",
  "telemetry_quality",
  "telemetry_machine",
];

describe("prEvidenceAffectedPages", () => {
  it("photographs every Telemetry tab when a Telemetry file changes", () => {
    const tabs = [
      "telemetry",
      "telemetry_cost",
      "telemetry_throughput",
      "telemetry_quality",
      "telemetry_machine",
    ];
    expect(prEvidenceAffectedPages(["apps/web/src/telemetry/MachineTab.tsx"])).toEqual(tabs);
    expect(prEvidenceAffectedPages(["apps/web/src/pages/Telemetry.tsx"])).toEqual(tabs);
    expect(EVIDENCE_PAGE_PATHS.telemetry_throughput).toBe("/telemetry?tab=throughput");
    expect(EVIDENCE_PAGE_PATHS.telemetry_machine).toBe("/telemetry?tab=machine");
  });

  it("maps changed paths to pages; whole app on hud.css", () => {
    expect(prEvidenceAffectedPages(["apps/web/src/board/Card.tsx"])).toEqual(["board"]);
    expect(
      prEvidenceAffectedPages(["apps/web/src/pages/MapPage.tsx", "apps/web/src/comms/older.ts"]),
    ).toEqual(["map", "comms"]);
    expect(prEvidenceAffectedPages(["apps/web/src/pages/Audit.tsx"])).toEqual(["audit"]);
    expect(prEvidenceAffectedPages(["apps/web/src/pages/QaReadiness.tsx"])).toEqual(["qa"]);
    expect(prEvidenceAffectedPages(["apps/web/src/pages/QaHotspots.tsx"])).toEqual(["qa"]);
    expect(prEvidenceAffectedPages(["apps/web/src/setup/Accounts.tsx"])).toEqual([
      "setup",
      "setup_repos",
      "setup_loops",
      "setup_accounts",
      "setup_roles",
      "setup_sources",
      "setup_access",
    ]);
    expect(prEvidenceAffectedPages(["apps/web/src/hud.css"])).toEqual(ALL);
    expect(prEvidenceAffectedPages(["apps/web/src/shell/Header.tsx"])).toEqual(ALL);
    expect(prEvidenceAffectedPages(["apps/web/src/components/Markdown.tsx"])).toEqual(ALL);
  });

  it("uses the import graph: a file maps to the pages that reach it, else the folder rule", () => {
    const graph = {
      "apps/web/src/comms/ItemBrief.tsx": ["comms", "needs"],
      "apps/web/src/setup/Accounts.tsx": ["setup"],
      "apps/web/src/shell/Header.tsx": [...ALL],
    } as never;
    expect(prEvidenceAffectedPages(["apps/web/src/comms/ItemBrief.tsx"], graph)).toEqual([
      "needs",
      "comms",
    ]);
    expect(prEvidenceAffectedPages(["apps/web/src/setup/Accounts.tsx"], graph)).toEqual([
      "setup",
      "setup_repos",
      "setup_loops",
      "setup_accounts",
      "setup_roles",
      "setup_sources",
      "setup_access",
    ]);
    expect(prEvidenceAffectedPages(["apps/web/src/shell/Header.tsx"], graph)).toEqual(ALL);
    // not in the graph: today's folder rule
    expect(prEvidenceAffectedPages(["apps/web/src/board/Card.tsx"], graph)).toEqual(["board"]);
    expect(prEvidenceAffectedPages(["apps/web/src/comms/ItemBrief.tsx"])).toEqual(["comms"]);
  });

  it("treats a file it cannot place as the whole app, and a test-only change as none", () => {
    expect(prEvidenceAffectedPages(["apps/web/src/palette/Palette.tsx"])).toEqual(ALL);
    expect(prEvidenceAffectedPages(["apps/web/package.json"])).toEqual(ALL);
    expect(prEvidenceAffectedPages(["apps/web/test/board.test.tsx"])).toEqual([]);
    expect(prEvidenceAffectedPages(["apps/web/src/board/cards.test.ts"])).toEqual([]);
    expect(prEvidenceAffectedPages(["apps/server/src/api.ts", "docs/runbook.md"])).toEqual([]);
  });
});

const manifest = (over: Partial<EvidenceManifest> = {}): EvidenceManifest => ({
  repoId: "mc",
  pr: 7,
  sha: "a".repeat(40),
  mainSha: "b".repeat(40),
  capturedAt: 1,
  pairs: ["light", "dark"].map((scheme) => ({
    page: "board" as const,
    scheme: scheme as "light" | "dark",
    changedPixels: 120,
    changedPercent: 0.01,
    regions: [{ x: 16, y: 32, width: 48, height: 16 }],
  })),
  ...over,
});

describe("evidenceMissing", () => {
  const light = [{ scheme: "light" as const, width: 1600 }];
  it("lists every page without a pair for this head, in light at 1600 unless told otherwise", () => {
    expect(evidenceMissing(null, "a".repeat(40), ["board"])).toEqual([
      { page: "board", scheme: "light", width: 1600 },
    ]);
    expect(evidenceMissing(manifest(), "a".repeat(40), ["board"])).toEqual([]);
    expect(evidenceMissing(manifest(), "a".repeat(40), ["board", "map"])).toEqual([
      { page: "map", scheme: "light", width: 1600 },
    ]);
  });

  it("does not count pairs captured for an older head", () => {
    expect(evidenceMissing(manifest(), "c".repeat(40), ["board"])).toHaveLength(1);
  });

  it("counts a page found unchanged as answered, and needs every variant of a changed page", () => {
    const sha = "a".repeat(40);
    expect(evidenceMissing(manifest({ pairs: [], unchanged: ["board"] }), sha, ["board"])).toEqual(
      [],
    );
    expect(
      evidenceMissing(manifest({ pairs: [], unchanged: ["board"] }), "c".repeat(40), ["board"]),
    ).toHaveLength(1);
    expect(
      evidenceMissing(
        manifest({ pairs: manifest().pairs.slice(0, 1) }),
        sha,
        ["board"],
        evidenceVariants(["apps/web/src/theme.css"]),
      ),
    ).toEqual([{ page: "board", scheme: "dark", width: 1600 }]);
    expect(evidenceMissing(null, sha, ["board"], light)).toHaveLength(1);
  });

  it("names the missing pages in the refusal", () => {
    const text = evidenceRefusalText(evidenceMissing(null, "a".repeat(40), ["board", "map"]));
    expect(text).toContain("board");
    expect(text).toContain("map");
    expect(text).toMatch(/draft/);
  });
});

describe("evidenceVariants", () => {
  it("is light at 1600 wide unless a changed file is about colour or width", () => {
    expect(evidenceVariants(["apps/web/src/board/Card.tsx"])).toEqual([
      { scheme: "light", width: 1600 },
    ]);
    expect(evidenceVariants(["apps/web/src/theme.ts"]).map((v) => v.scheme)).toEqual([
      "light",
      "dark",
    ]);
    expect(
      evidenceVariants(["apps/web/src/shell/useViewportWidth.ts"]).map((v) => v.width),
    ).toEqual([1600, 2560]);
    // a server file about layout does not widen a web capture
    expect(evidenceVariants(["apps/server/src/layout.ts"])).toHaveLength(1);
  });
});

describe("image names", () => {
  it("builds a name that only the fixed pattern accepts", () => {
    const name = evidenceImageName("board", "dark", "diff");
    expect(name).toBe("board-dark-diff.png");
    expect(isEvidenceImageName(name)).toBe(true);
    expect(isEvidenceImageName("../board-dark-diff.png")).toBe(false);
    expect(isEvidenceImageName("manifest.json")).toBe(false);
    expect(isEvidenceImageName("board-blue-diff.png")).toBe(false);
  });

  it("names a wide picture with its width", () => {
    const name = evidenceImageName("board", "light", "before", 2560);
    expect(name).toBe("board-light-2560-before.png");
    expect(isEvidenceImageName(name)).toBe(true);
    expect(isEvidenceImageName("board-light-999-before.png")).toBe(false);
  });
});

describe("withSection", () => {
  const body = "#9 — Title\n\n## What changed\n\nDid it.\n\nCloses #9.";

  it("puts the section before the Closes line", () => {
    const out = withSection(body, EVIDENCE_HEADING, `${EVIDENCE_HEADING}\n\nline`);
    expect(out).toBe(
      `#9 — Title\n\n## What changed\n\nDid it.\n\n${EVIDENCE_HEADING}\n\nline\n\nCloses #9.`,
    );
  });

  it("splices the evidence section without erasing the Minor section or the Closes line", () => {
    const withMinor = `${body.replace("\n\nCloses", "\n\n## Minor findings\n\n- one\n\nCloses")}`;
    const once = withSection(withMinor, EVIDENCE_HEADING, `${EVIDENCE_HEADING}\n\nold`);
    const twice = withSection(once, EVIDENCE_HEADING, `${EVIDENCE_HEADING}\n\nnew`);
    expect(twice).toContain("## Minor findings\n\n- one");
    expect(twice).toContain(`${EVIDENCE_HEADING}\n\nnew`);
    expect(twice).not.toContain("old");
    expect(twice.endsWith("Closes #9.")).toBe(true);
    expect(twice.split(EVIDENCE_HEADING)).toHaveLength(2);
  });

  it("removes the section when given null, and reads it back with sectionOf", () => {
    const set = withSection(body, EVIDENCE_HEADING, `${EVIDENCE_HEADING}\n\nline`);
    expect(sectionOf(set, EVIDENCE_HEADING)).toBe(`${EVIDENCE_HEADING}\n\nline`);
    expect(withSection(set, EVIDENCE_HEADING, null)).toBe(body);
    expect(sectionOf(body, EVIDENCE_HEADING)).toBeNull();
  });

  it("appends when the body has no Closes line", () => {
    expect(withSection("text", EVIDENCE_HEADING, `${EVIDENCE_HEADING}\n\nx`)).toBe(
      `text\n\n${EVIDENCE_HEADING}\n\nx`,
    );
  });
});

describe("withSection on a staged body ending Part of", () => {
  const body = "#9 — Title\n\n## What changed\n\nDid it.\n\nPart of #9.";
  const section = `${EVIDENCE_HEADING}\n\nline`;

  it("puts the section before the Part of line", () => {
    expect(withSection(body, EVIDENCE_HEADING, section)).toBe(
      `#9 — Title\n\n## What changed\n\nDid it.\n\n${section}\n\nPart of #9.`,
    );
  });

  it("stops sectionOf before the Part of line, and removal restores the body", () => {
    const set = withSection(body, EVIDENCE_HEADING, section);
    expect(sectionOf(set, EVIDENCE_HEADING)).toBe(section);
    expect(withSection(set, EVIDENCE_HEADING, null)).toBe(body);
    const twice = withSection(set, EVIDENCE_HEADING, `${EVIDENCE_HEADING}\n\nnew`);
    expect(twice.endsWith("\n\nPart of #9.")).toBe(true);
    expect(twice.match(/Part of #9\./g)).toHaveLength(1);
  });
});

describe("evidenceSectionText", () => {
  it("links a changed page's before, after and diff on the hub when nothing is published", () => {
    const text = evidenceSectionText(manifest(), "http://127.0.0.1:7421");
    expect(text.startsWith(EVIDENCE_HEADING)).toBe(true);
    expect(text).toContain(
      `http://127.0.0.1:7421/api/prs/7/evidence/${"a".repeat(40)}/board-light-diff.png`,
    );
    expect(text).toContain("1 region");
  });

  it("shows only changed pages as before and after release pictures, and names the rest", () => {
    const text = evidenceSectionText(
      manifest({
        published: { baseUrl: `https://github.com/o/r/releases/download/${evidenceReleaseTag(7)}` },
        unchanged: ["map", "comms"],
        pairs: [
          { ...manifest().pairs[0], width: 2560 } as EvidenceManifest["pairs"][number],
          { ...manifest().pairs[0], page: "board", changedPixels: 0 },
        ],
      }),
      "http://h",
    );
    expect(text).toContain(
      "![before](https://github.com/o/r/releases/download/qa-pr-7/board-light-2560-before.png)",
    );
    expect(text).toContain(
      "![after](https://github.com/o/r/releases/download/qa-pr-7/board-light-2560-after.png)",
    );
    expect(text).not.toContain("diff.png");
    expect(text).not.toContain("http://h");
    expect(text).toContain("Unchanged: map, comms.");
    expect(text).not.toContain("board, light:");
  });

  it("says so when nothing changed", () => {
    expect(
      evidenceSectionText(manifest({ pairs: [], unchanged: ["board"] }), "http://h"),
    ).toContain("No page changed.");
  });
});

describe("prEvidenceUncatalogued: a page no screenshot can show", () => {
  it("names a new page file with no evidence address", () => {
    expect(
      prEvidenceUncatalogued([
        "apps/web/src/pages/Inbox.tsx",
        "apps/web/src/pages/Needs.tsx",
        "apps/web/src/pages/QaHotspots.tsx",
        "apps/web/src/pages/CommsChartPage.tsx",
        "apps/web/src/pages/TicketPage.tsx",
        "apps/web/src/pages/Inbox.test.tsx",
        "apps/web/src/needs/NeedsList.tsx",
      ]),
    ).toEqual(["pages/Inbox.tsx"]);
    expect(evidenceUncataloguedText(["pages/Inbox.tsx"])).toContain(
      "pages/Inbox.tsx has no screenshot address",
    );
  });

  it("maps the pages that have an address, and aliases to their host page", () => {
    expect(prEvidenceAffectedPages(["apps/web/src/pages/Needs.tsx"])).toEqual(["needs"]);
    expect(prEvidenceAffectedPages(["apps/web/src/pages/CommsChartPage.tsx"])).toEqual(ALL);
    expect(prEvidenceAffectedPages(["apps/web/src/pages/LegacyAudit.tsx"])).toEqual(["audit"]);
    expect(prEvidenceAffectedPages(["apps/web/src/pages/qa-hotspots.css"])).toEqual(["qa"]);
  });

  it("lifts the hold when the PR also changes the catalogue, which the hub reads from main", () => {
    expect(
      prEvidenceUncatalogued(["apps/web/src/pages/Inbox.tsx", "packages/core/src/pr-evidence.ts"]),
    ).toEqual([]);
    expect(
      prEvidenceUncatalogued(["apps/web/src/pages/Inbox.tsx", "packages/core/src/flight.ts"]),
    ).toEqual([]);
  });

  it("does not take inherited object keys for pages", () => {
    expect(prEvidenceUncatalogued(["apps/web/src/pages/Constructor.tsx"])).toEqual([
      "pages/Constructor.tsx",
    ]);
    expect(prEvidenceAffectedPages(["apps/web/src/pages/Constructor.tsx"])).toEqual(ALL);
  });

  it("every page in apps/web has an address, an alias or a stated reason", () => {
    const dir = join(import.meta.dirname, "../../../apps/web/src/pages");
    const pages = readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => `apps/web/src/pages/${f}`);
    expect(pages.length).toBeGreaterThan(5);
    expect(prEvidenceUncatalogued(pages)).toEqual([]);
  });
});
