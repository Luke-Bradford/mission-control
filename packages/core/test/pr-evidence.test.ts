import { describe, expect, it } from "vitest";
import {
  EVIDENCE_HEADING,
  type EvidenceManifest,
  evidenceImageName,
  evidenceMissing,
  evidenceRefusalText,
  evidenceSectionText,
  HUD_PAGE_PATHS,
  isEvidenceImageName,
  prEvidenceAffectedPages,
  sectionOf,
  withSection,
} from "../src/index.ts";

const ALL = [
  ...Object.keys(HUD_PAGE_PATHS),
  "readiness",
  "hotspots",
  "setup_repos",
  "setup_loops",
  "setup_accounts",
  "setup_roles",
  "setup_sources",
  "setup_access",
];

describe("prEvidenceAffectedPages", () => {
  it("maps changed paths to pages; whole app on hud.css", () => {
    expect(prEvidenceAffectedPages(["apps/web/src/board/Card.tsx"])).toEqual(["board"]);
    expect(
      prEvidenceAffectedPages(["apps/web/src/pages/MapPage.tsx", "apps/web/src/comms/older.ts"]),
    ).toEqual(["map", "comms"]);
    expect(prEvidenceAffectedPages(["apps/web/src/pages/Audit.tsx"])).toEqual([
      "audit",
      "readiness",
      "hotspots",
    ]);
    expect(prEvidenceAffectedPages(["apps/web/src/pages/QaReadiness.tsx"])).toEqual(["qa"]);
    expect(prEvidenceAffectedPages(["apps/web/src/pages/QaHotspots.tsx"])).toEqual(["hotspots"]);
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
  it("lists every page and scheme without a pair for this head", () => {
    expect(evidenceMissing(null, "a".repeat(40), ["board"])).toEqual([
      { page: "board", scheme: "light" },
      { page: "board", scheme: "dark" },
    ]);
    expect(evidenceMissing(manifest(), "a".repeat(40), ["board"])).toEqual([]);
    expect(evidenceMissing(manifest(), "a".repeat(40), ["board", "map"])).toEqual([
      { page: "map", scheme: "light" },
      { page: "map", scheme: "dark" },
    ]);
  });

  it("does not count pairs captured for an older head", () => {
    expect(evidenceMissing(manifest(), "c".repeat(40), ["board"])).toHaveLength(2);
  });

  it("names the missing pages in the refusal", () => {
    const text = evidenceRefusalText(evidenceMissing(null, "a".repeat(40), ["board", "map"]));
    expect(text).toContain("board");
    expect(text).toContain("map");
    expect(text).toMatch(/draft/);
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

describe("evidenceSectionText", () => {
  it("links each pair's before, after and diff under the head sha", () => {
    const text = evidenceSectionText(manifest(), "http://127.0.0.1:7421");
    expect(text.startsWith(EVIDENCE_HEADING)).toBe(true);
    expect(text).toContain(
      `http://127.0.0.1:7421/api/prs/7/evidence/${"a".repeat(40)}/board-light-diff.png`,
    );
    expect(text).toContain("1 region");
  });
});
