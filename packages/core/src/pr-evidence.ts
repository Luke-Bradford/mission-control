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
  qa: "qa",
};

/** `pages/` files shown at another page's address, so that page's screenshots cover them. */
const PAGE_ALIASES: Record<string, EvidencePage> = {
  qareadiness: "qa",
  "qa-readiness": "qa",
  qahotspots: "hotspots",
  "qa-hotspots": "hotspots",
  legacyaudit: "audit",
};

/** `pages/` files with no fixed address, so no screenshot can show them. */
export const UNPHOTOGRAPHED_PAGES: Readonly<Record<string, string>> = {
  ticket: "a ticket's page has no fixed address",
  commschart: "a live, animated chart; not photographed until the capture probe shows it settles",
};

/** Files whose change adds or removes a page's evidence address. */
const CATALOGUE_FILES = ["packages/core/src/pr-evidence.ts", "packages/core/src/flight.ts"];

/** A `pages/` file's page key: its name, lower case, without the extension or a `Page` suffix. */
const pageKey = (file: string): string =>
  file
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/page$/, "");

/** The page a file in `apps/web` affects, or null when it affects the whole app. */
function pageOf(path: string): EvidencePage | null {
  const rest = path.slice(WEB_PREFIX.length).replace(/^src\//, "");
  const dir = rest.split("/")[0] ?? "";
  if (rest.includes("/") && dir !== "pages") return PAGE_DIRS[dir] ?? null;
  if (dir === "pages") {
    const key = pageKey(rest.split("/")[1] ?? "");
    if (Object.hasOwn(PAGE_ALIASES, key)) return PAGE_ALIASES[key] ?? null;
    return Object.hasOwn(EVIDENCE_PAGE_PATHS, key) ? (key as EvidencePage) : null;
  }
  return null;
}

/** The page a `pages/` file is, or null when it has no screenshot address; for the import graph. */
export function evidencePageOfPageFile(path: string): EvidencePage | null {
  const rest = path.slice(WEB_PREFIX.length).replace(/^src\//, "");
  return rest.startsWith("pages/") ? pageOf(path) : null;
}

/**
 * The pages that reach each file under `apps/web/src` through static imports, keyed by repo path.
 * Read from the PR head's checkout; a file the shell reaches lists every page.
 */
export type WebPageGraph = Readonly<Record<string, readonly EvidencePage[]>>;

/**
 * The HUD pages a change to these paths can alter, in nav order. A page's own directory or
 * `pages/` file affects that page; the stylesheet, the shell, shared components and any file that
 * cannot be placed affect them all; test files and paths outside `apps/web` affect none. With a
 * `graph`, a file it lists affects the pages that import it (the shell's files, every page); a file
 * it does not list, or no graph, keeps that folder rule.
 */
export function prEvidenceAffectedPages(
  paths: readonly string[],
  graph?: WebPageGraph,
): EvidencePage[] {
  const hit = new Set<EvidencePage>();
  const add = (page: EvidencePage) => {
    hit.add(page);
    if (page === "audit") {
      hit.add("readiness");
      hit.add("hotspots");
    }
    if (page === "setup") for (const p of EVIDENCE_PAGES) if (p.startsWith("setup_")) hit.add(p);
  };
  for (const path of paths) {
    if (!path.startsWith(WEB_PREFIX) || TEST_FILE.test(path)) continue;
    const reached = graph !== undefined && Object.hasOwn(graph, path) ? graph[path] : undefined;
    if (reached !== undefined) {
      for (const page of reached) add(page);
      continue;
    }
    const page = pageOf(path);
    if (page === null) return [...EVIDENCE_PAGES];
    add(page);
  }
  return EVIDENCE_PAGES.filter((p) => hit.has(p));
}

/**
 * Page files in `apps/web/src/pages` that no screenshot can show: a page with no evidence address,
 * alias or stated reason. Such a change would otherwise count as "every known page" and never
 * photograph itself (PR 1465, the Needs you page, #1529). Empty when the PR also changes the
 * catalogue: the hub photographs from main's catalogue, so a page and its address in one PR could
 * never leave draft. That PR's page is then the reviewer's to render (a design verdict needs a
 * render or images of the head).
 */
export function prEvidenceUncatalogued(paths: readonly string[]): string[] {
  if (paths.some((path) => CATALOGUE_FILES.includes(path))) return [];
  const out = new Set<string>();
  for (const path of paths) {
    if (!/^apps\/web\/src\/pages\/[^/]+\.tsx$/.test(path) || TEST_FILE.test(path)) continue;
    const key = pageKey(path.split("/").at(-1) ?? "");
    if (
      Object.hasOwn(EVIDENCE_PAGE_PATHS, key) ||
      Object.hasOwn(PAGE_ALIASES, key) ||
      Object.hasOwn(UNPHOTOGRAPHED_PAGES, key)
    )
      continue;
    out.add(path.slice("apps/web/src/".length));
  }
  return [...out].sort();
}

/** Why a web PR stays in draft: a page no screenshot can show. */
export function evidenceUncataloguedText(files: readonly string[]): string {
  return `kept in draft: ${files.join(", ")} has no screenshot address, so its evidence cannot show it. Add the page to EVIDENCE_PAGE_PATHS in packages/core/src/pr-evidence.ts (or HUD_PAGE_PATHS in packages/core/src/flight.ts when it is in the nav), in this PR or one before it; a page removed by this PR leaves draft the same way`;
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

/**
 * The labels the evidence capture clicks on the Audit page. The page renders them and the capture
 * finds its controls by them, so each lives here once; a rename on either side then fails a test
 * (apps/server/test/qa-labels.test.ts) instead of timing out a live capture.
 */
export const QA_VIEW_LABEL = "QA view";
export const QA_DISCLOSURE_LABEL = "Workflow history and earlier proposals";
/** The button text of each Audit tab a capture selects. */
export const QA_TAB_LABELS = { readiness: "PR readiness", hotspots: "Hotspots" } as const;
export type QaTab = keyof typeof QA_TAB_LABELS;
