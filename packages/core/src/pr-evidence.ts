/**
 * Screenshot evidence for a PR that changes the HUD: which pages a change affects, the stored
 * before/after pairs, what is still missing for a head, and the PR-body section that links them.
 */
import { HUD_PAGE_PATHS } from "./flight.ts";

/** The colour schemes every affected page is photographed in. */
export const EVIDENCE_SCHEMES = ["light", "dark"] as const;
export type EvidenceScheme = (typeof EVIDENCE_SCHEMES)[number];
/** The viewport of every evidence screenshot. */
export const EVIDENCE_VIEWPORT = { width: 1600, height: 1000 } as const;
/** Audit has three independent views; a shot of its default tab cannot prove the others. */
export const EVIDENCE_PAGE_PATHS = {
  ...HUD_PAGE_PATHS,
  readiness: "/audit?evidence-tab=readiness",
  hotspots: "/audit?evidence-tab=hotspots",
  setup_repos: "/setup/repos",
  setup_loops: "/setup/loops",
  setup_accounts: "/setup/accounts",
  setup_roles: "/setup/roles",
  setup_sources: "/setup/sources",
  setup_access: "/setup/access",
} as const;
export type EvidencePage = keyof typeof EVIDENCE_PAGE_PATHS;
export const EVIDENCE_PAGES = Object.keys(EVIDENCE_PAGE_PATHS) as EvidencePage[];
export const EVIDENCE_KINDS = ["before", "after", "diff"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** The PR-body heading of the evidence section. */
export const EVIDENCE_HEADING = "## Screenshot evidence";

export interface EvidenceRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EvidencePair {
  page: EvidencePage;
  scheme: EvidenceScheme;
  changedPixels: number;
  /** Of the whole image, 0 to 100. */
  changedPercent: number;
  /** Bounding boxes of the changed areas, largest first. */
  regions: EvidenceRegion[];
}

/** What a capture stored for one head sha (`manifest.json`, and `GET /api/prs/:n/evidence`). */
export interface EvidenceManifest {
  repoId: string;
  pr: number;
  sha: string;
  /** The main commit the "before" side was built from. */
  mainSha: string;
  capturedAt: number;
  pairs: EvidencePair[];
}

const WEB_PREFIX = "apps/web/";
const TEST_FILE = /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** The directories under `apps/web/src` that belong to one page alone. */
const PAGE_DIRS: Record<string, EvidencePage> = {
  overview: "overview",
  flight: "flight",
  board: "board",
  agent: "agent",
  map: "map",
  comms: "comms",
  telemetry: "telemetry",
  setup: "setup",
  qa: "readiness",
};

/** The page a file in `apps/web` affects, or null when it affects the whole app. */
function pageOf(path: string): EvidencePage | null {
  const rest = path.slice(WEB_PREFIX.length).replace(/^src\//, "");
  const dir = rest.split("/")[0] ?? "";
  if (rest.includes("/") && dir !== "pages") return PAGE_DIRS[dir] ?? null;
  if (dir === "pages") {
    const stem = (rest.split("/")[1] ?? "").replace(/\.[^.]+$/, "").toLowerCase();
    const key = stem.replace(/page$/, "");
    if (key === "qareadiness") return "readiness";
    if (key === "qahotspots") return "hotspots";
    return key in HUD_PAGE_PATHS ? (key as EvidencePage) : null;
  }
  return null;
}

/**
 * The HUD pages a change to these paths can alter, in nav order. A page's own directory or
 * `pages/` file affects that page; the stylesheet, the shell, shared components and any file that
 * cannot be placed affect them all; test files and paths outside `apps/web` affect none.
 */
export function prEvidenceAffectedPages(paths: readonly string[]): EvidencePage[] {
  const hit = new Set<EvidencePage>();
  for (const path of paths) {
    if (!path.startsWith(WEB_PREFIX) || TEST_FILE.test(path)) continue;
    const page = pageOf(path);
    if (page === null) return [...EVIDENCE_PAGES];
    hit.add(page);
    if (page === "audit") {
      hit.add("readiness");
      hit.add("hotspots");
    }
    if (page === "setup") for (const p of EVIDENCE_PAGES) if (p.startsWith("setup_")) hit.add(p);
  }
  return EVIDENCE_PAGES.filter((p) => hit.has(p));
}

export interface EvidenceGap {
  page: EvidencePage;
  scheme: EvidenceScheme;
}

/** Every page and scheme `pages` needs that `manifest` has no pair for at this head. */
export function evidenceMissing(
  manifest: EvidenceManifest | null,
  sha: string,
  pages: readonly EvidencePage[],
): EvidenceGap[] {
  const have = manifest?.sha === sha ? manifest.pairs : [];
  return pages.flatMap((page) =>
    EVIDENCE_SCHEMES.filter(
      (scheme) => !have.some((p) => p.page === page && p.scheme === scheme),
    ).map((scheme) => ({ page, scheme })),
  );
}

/** Why a web PR stays in draft: the pages whose screenshot pairs do not exist yet. */
export function evidenceRefusalText(missing: readonly EvidenceGap[]): string {
  const pages = [...new Set(missing.map((m) => m.page))].join(", ");
  return `kept in draft until its screenshot evidence exists; missing pages: ${pages}`;
}

const IMAGE_NAME = new RegExp(
  `^(?:${EVIDENCE_PAGES.join("|")})-(?:${EVIDENCE_SCHEMES.join("|")})-(?:${EVIDENCE_KINDS.join("|")})\\.png$`,
);
export const evidenceImageName = (
  page: EvidencePage,
  scheme: EvidenceScheme,
  kind: EvidenceKind,
): string => `${page}-${scheme}-${kind}.png`;
/** Whether `name` is one a capture can have stored; anything else is never turned into a path. */
export const isEvidenceImageName = (name: string): boolean => IMAGE_NAME.test(name);

const CLOSES = /^Closes #\d+\.$/;
const isHeading = (line: string): boolean => /^## /.test(line);

/** The `heading` section of a PR body (the heading line included), or null when it has none. */
export function sectionOf(body: string, heading: string): string | null {
  const lines = body.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !isHeading(lines[end] ?? "") && !CLOSES.test(lines[end] ?? ""))
    end += 1;
  return lines.slice(start, end).join("\n").trimEnd();
}

/**
 * `body` with its `heading` section replaced by `section` (removed when null). A new section goes
 * before the closing "Closes #n." line, so the other sections and that line are left as they were.
 */
export function withSection(body: string, heading: string, section: string | null): string {
  let lines = body.split("\n");
  const start = lines.indexOf(heading);
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !isHeading(lines[end] ?? "") && !CLOSES.test(lines[end] ?? ""))
      end += 1;
    lines = [...lines.slice(0, start), ...lines.slice(end)];
  }
  if (section === null) return lines.join("\n");
  const closes = lines.findLastIndex((l) => CLOSES.test(l));
  if (closes < 0) return `${lines.join("\n").trimEnd()}\n\n${section}`;
  return [...lines.slice(0, closes), section, "", ...lines.slice(closes)].join("\n");
}

const regionsText = (n: number): string => (n === 1 ? "1 region" : `${n} regions`);

/** The PR-body section: one line per pair, with links to its before, after and diff images. */
export function evidenceSectionText(manifest: EvidenceManifest, baseUrl: string): string {
  const link = (p: EvidencePair, kind: EvidenceKind): string =>
    `[${kind}](${baseUrl}/api/prs/${manifest.pr}/evidence/${manifest.sha}/${evidenceImageName(p.page, p.scheme, kind)})`;
  const lines = manifest.pairs.map(
    (p) =>
      `- ${p.page}, ${p.scheme}: ${p.changedPixels === 0 ? "no change" : `${p.changedPercent}% changed, ${regionsText(p.regions.length)}`} (${EVIDENCE_KINDS.map((k) => link(p, k)).join(" · ")})`,
  );
  return [
    EVIDENCE_HEADING,
    "",
    `Rendered at ${EVIDENCE_VIEWPORT.width}×${EVIDENCE_VIEWPORT.height} from ${manifest.sha.slice(0, 7)} against main ${manifest.mainSha.slice(0, 7)}, on the same data. Links open on the hub that rendered them.`,
    "",
    ...lines,
  ].join("\n");
}
