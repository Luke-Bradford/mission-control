/**
 * Screenshot evidence for a PR that changes the HUD: which pages a change affects, the stored
 * before/after pairs, what is still missing for a head, and the PR-body section that links them.
 */
import { HUD_PAGE_PATHS } from "./flight.ts";

/** The colour schemes a page can be photographed in; a change is photographed in `light` unless it is about colour. */
export const EVIDENCE_SCHEMES = ["light", "dark"] as const;
export type EvidenceScheme = (typeof EVIDENCE_SCHEMES)[number];
/** The viewport of an evidence screenshot, unless the change is about width. */
export const EVIDENCE_VIEWPORT = { width: 1600, height: 1000 } as const;
/** The second viewport, taken only when the change is about width. */
export const EVIDENCE_WIDE_VIEWPORT = { width: 2560, height: 1145 } as const;
export const EVIDENCE_WIDTHS = [EVIDENCE_VIEWPORT.width, EVIDENCE_WIDE_VIEWPORT.width] as const;
export const EVIDENCE_PAGE_PATHS = {
  ...HUD_PAGE_PATHS,
  setup_repos: "/setup/repos",
  setup_loops: "/setup/loops",
  setup_accounts: "/setup/accounts",
  setup_roles: "/setup/roles",
  setup_sources: "/setup/sources",
  setup_access: "/setup/access",
  // The Telemetry tabs; the bare address is the Crew tab.
  telemetry_cost: "/telemetry?tab=cost",
  telemetry_throughput: "/telemetry?tab=throughput",
  telemetry_quality: "/telemetry?tab=quality",
  telemetry_machine: "/telemetry?tab=machine",
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
  /** The viewport width; absent means `EVIDENCE_VIEWPORT.width`. */
  width?: number;
  changedPixels: number;
  /** Of the whole image, 0 to 100. */
  changedPercent: number;
  /** Bounding boxes of the changed areas, largest first. */
  regions: EvidenceRegion[];
}

/** A committed picture FLIGHT supplied for a review the hub cannot render itself. */
export interface EvidenceSubmission {
  name: string;
  caption: string;
  viewport: { width: number; height: number };
  side: "head" | "base" | "reference";
  path: string;
}

/** What a capture stored for one head sha (`manifest.json`, and `GET /api/prs/:n/evidence`). */
export interface EvidenceManifest {
  repoId: string;
  pr: number;
  sha: string;
  /** The main commit the "before" side was built from. */
  mainSha: string;
  capturedAt: number;
  /** The pairs of the pages that changed; a page that did not change keeps none. */
  pairs: EvidencePair[];
  /** The pages photographed that did not change: nothing is kept for them. */
  unchanged?: EvidencePage[];
  /** The schemes and widths this head was photographed in; absent on a capture made before they were recorded. */
  variants?: EvidenceVariant[];
  /** Where the before and after pictures are published on GitHub (release files), when they were. */
  published?: { baseUrl: string };
  /** Extra committed pictures, retained only for this exact review head. */
  submitted?: EvidenceSubmission[];
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
  qahotspots: "qa",
  "qa-hotspots": "qa",
  legacyaudit: "audit",
  modeltable: "audit",
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
    for (const family of ["setup", "telemetry"])
      if (page === family)
        for (const p of EVIDENCE_PAGES) if (p.startsWith(`${family}_`)) hit.add(p);
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

/** One scheme and width a page is photographed in. */
export interface EvidenceVariant {
  scheme: EvidenceScheme;
  width: number;
}

export interface EvidenceGap extends EvidenceVariant {
  page: EvidencePage;
}

/** A change to files named for colour, or whose changed lines set colour, is photographed in both schemes. */
const THEME_FILE = /(?:theme|dark|light|colou?r|tokens?|palette)/i;
const THEME_TEXT =
  /prefers-color-scheme|data-theme|color-scheme|\b(?:dark|light)\b|#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|color-mix)\(|(?:^|[\s;{])(?:background(?:-color)?|color|border(?:-\w+)?-color|fill|stroke)\s*:|--[\w-]*(?:color|bg|fg|surface|ink)/im;
/** The same for size: file names, or changed lines with a media query, a width declaration or a breakpoint. */
const WIDTH_FILE = /(?:width|responsive|breakpoint|viewport|layout|resize)/i;
const WIDTH_TEXT =
  /@media|@container|(?:^[+-]?|[\s;{])(?:(?:min|max)-)?(?:width|inline-size)\s*:|\b(?:min|max)-(?:width|inline-size)\b|\bvw\b|\bclamp\(|grid-template-columns|breakpoint/im;

const variantsOf = (
  schemes: readonly EvidenceScheme[],
  widths: readonly number[],
): EvidenceVariant[] => schemes.flatMap((scheme) => widths.map((width) => ({ scheme, width })));

/** Every scheme at every width: what a change that cannot be read is photographed in. */
export const evidenceAllVariants = (): EvidenceVariant[] =>
  variantsOf(EVIDENCE_SCHEMES, EVIDENCE_WIDTHS);

/**
 * What each changed page is photographed in: light at 1600 wide, plus dark when a changed web file
 * is named for colour or its changed lines (`changeText`, the diff's added and removed lines) set
 * colour, plus the wide viewport when the same holds for width.
 */
export function evidenceVariants(
  paths: readonly string[] = [],
  changeText = "",
): EvidenceVariant[] {
  const names = paths.filter((p) => p.startsWith(WEB_PREFIX)).map((p) => p.split("/").at(-1) ?? "");
  const theme = names.some((n) => THEME_FILE.test(n)) || THEME_TEXT.test(changeText);
  const wide = names.some((n) => WIDTH_FILE.test(n)) || WIDTH_TEXT.test(changeText);
  return variantsOf(
    theme ? EVIDENCE_SCHEMES : ["light"],
    wide ? EVIDENCE_WIDTHS : [EVIDENCE_VIEWPORT.width],
  );
}

/** The width a pair was taken at. */
export const evidenceWidthOf = (p: { width?: number }): number =>
  p.width ?? EVIDENCE_VIEWPORT.width;

/**
 * Every page and variant `pages` needs that `manifest` has no answer for at this head. A page the
 * capture found unchanged is answered; so is a page with a pair in every variant.
 */
export function evidenceMissing(
  manifest: EvidenceManifest | null,
  sha: string,
  pages: readonly EvidencePage[],
  variants: readonly EvidenceVariant[] = evidenceVariants(),
): EvidenceGap[] {
  const have = manifest?.sha === sha ? manifest : null;
  return pages.flatMap((page) =>
    have?.unchanged?.includes(page)
      ? []
      : variants
          .filter(
            (v) =>
              !have?.pairs.some(
                (p) => p.page === page && p.scheme === v.scheme && evidenceWidthOf(p) === v.width,
              ),
          )
          .map((v) => ({ page, ...v })),
  );
}

/** Why a web PR stays in draft: the pages whose screenshot pairs do not exist yet. */
export function evidenceRefusalText(missing: readonly EvidenceGap[]): string {
  const pages = [...new Set(missing.map((m) => m.page))].join(", ");
  return `kept in draft until its screenshot evidence exists; missing pages: ${pages}`;
}

const IMAGE_NAME = new RegExp(
  `^(?:${EVIDENCE_PAGES.join("|")})-(?:${EVIDENCE_SCHEMES.join("|")})-(?:(?:${EVIDENCE_WIDTHS.join("|")})-)?(?:${EVIDENCE_KINDS.join("|")})\\.png$`,
);
export const evidenceImageName = (
  page: EvidencePage,
  scheme: EvidenceScheme,
  kind: EvidenceKind,
  width: number = EVIDENCE_VIEWPORT.width,
): string =>
  width === EVIDENCE_VIEWPORT.width
    ? `${page}-${scheme}-${kind}.png`
    : `${page}-${scheme}-${width}-${kind}.png`;
/** Whether `name` is one a capture can have stored; anything else is never turned into a path. */
export const isEvidenceImageName = (name: string): boolean =>
  IMAGE_NAME.test(name) || /^submitted-[a-f0-9]{64}\.png$/.test(name);

const CLOSES = /^(?:Closes|Part of) #\d+\.$/;
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

/** The tag of the GitHub release that holds a PR's before and after pictures. */
export const EVIDENCE_RELEASE_PREFIX = "qa-pr-";
export const evidenceReleaseTag = (pr: number): string => `${EVIDENCE_RELEASE_PREFIX}${pr}`;

/**
 * The PR-body section: one entry per page that changed, with its before and after pictures. The
 * pictures are Demo data on both sides, so a page that did not change has none and is only named.
 */
export function evidenceSectionText(manifest: EvidenceManifest, baseUrl: string): string {
  const where =
    manifest.published?.baseUrl ?? `${baseUrl}/api/prs/${manifest.pr}/evidence/${manifest.sha}`;
  const link = (p: EvidencePair, kind: EvidenceKind): string =>
    `${where}/${evidenceImageName(p.page, p.scheme, kind, evidenceWidthOf(p))}`;
  const entries = manifest.pairs.map((p) => {
    const width = evidenceWidthOf(p);
    const label = `${p.page}, ${p.scheme}${width === EVIDENCE_VIEWPORT.width ? "" : `, ${width} wide`}`;
    const head = `- ${label}: ${p.changedPixels === 0 ? "no difference above the diff threshold" : `${p.changedPercent}% changed, ${regionsText(p.regions.length)}`}`;
    return manifest.published
      ? `${head}\n\n  | before | after |\n  | --- | --- |\n  | ![before](${link(p, "before")}) | ![after](${link(p, "after")}) |`
      : `${head} ([before](${link(p, "before")}) · [after](${link(p, "after")}) · [diff](${link(p, "diff")}))`;
  });
  const same = manifest.unchanged ?? [];
  return [
    EVIDENCE_HEADING,
    "",
    `Rendered from Demo data on both sides, from ${manifest.sha.slice(0, 7)} against main ${manifest.mainSha.slice(0, 7)}, at ${EVIDENCE_VIEWPORT.width}×${EVIDENCE_VIEWPORT.height} in light unless the change is about colour or width. Only pages that changed are shown.${manifest.published ? " The pictures are removed once the change is live." : " Links open on the hub that rendered them."}`,
    "",
    ...(entries.length > 0 ? entries : ["No page changed."]),
    ...(same.length > 0 ? ["", `Unchanged: ${same.join(", ")}.`] : []),
  ].join("\n");
}

/**
 * What the Demo render relies on in the web app: the sessionStorage key that turns Demo on, and the
 * marker's label that shows it is running. apps/web keeps its own copies (`DEMO_KEY` in
 * storage.ts, `DEMO_MARKER_TEXT` in demo/mode.ts); apps/server/test/demo-labels.test.ts fails
 * when either side changes alone.
 */
export const DEMO_SESSION_KEY = "mc-demo";
export const DEMO_MARKER_LABEL =
  "Simulated crew. Nothing here is real, and nothing is sent to the hub.";
