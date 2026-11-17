/** The pictures a plan carries: read from the planner's checkout, kept by content hash, served by id. */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { PLAN_MOCKUP_BYTES_MAX, type PlanMockup } from "@mc/core";
import { storedMediaType } from "../attention/attention-materials.ts";

const RASTER_EXT = /\.(?:png|jpe?g|webp)$/i;
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*%)(?:[^/]+\/)*[^/]+$/;
const ASSET_ID = /^[0-9a-f]{64}$/;

export const PLAN_ASSET_URL = "/api/plan-assets/";

/** Where the kept pictures live: beside the database. */
export const planAssetsDir = (dbPath: string): string => join(dirname(dbPath), "plan-assets");

export interface MockupInput {
  path: string;
  caption: string;
}

export type MockupsResult = { ok: true; mockups: PlanMockup[] } | { ok: false; text: string };

/**
 * Keeps each picture the plan names. A path is refused unless it is a plain PNG, JPEG or WebP file
 * inside the checkout (a symlink or a path out of it is not followed), at most 2 MB, and free of
 * any known secret. Nothing is kept unless every picture passes.
 */
export async function keepMockups(i: {
  worktree: string | null;
  dbPath: string;
  inputs: readonly MockupInput[];
  known: readonly string[];
}): Promise<MockupsResult> {
  if (i.inputs.length === 0) return { ok: true, mockups: [] };
  if (i.worktree === null)
    return { ok: false, text: "Not written: there is no checkout to read the mockups from." };
  const root = await realpath(i.worktree);
  const staged: { bytes: Buffer; caption: string; mediaType: PlanMockup["mediaType"] }[] = [];
  for (const { path, caption } of i.inputs) {
    const refuse = (why: string): MockupsResult => ({
      ok: false,
      text: `Not written: mockup ${path} ${why}. Name a PNG, JPEG or WebP file (at most 2 MB) inside the checkout, then call report_plan again.`,
    });
    if (!RELATIVE_PATH.test(path) || !RASTER_EXT.test(path))
      return refuse("is not a repo-relative PNG, JPEG or WebP path");
    const file = join(root, path);
    let real: string;
    try {
      real = await realpath(file);
      if (!(await lstat(file)).isFile()) return refuse("is not a plain file");
    } catch {
      return refuse("does not exist in the checkout");
    }
    // a symlink anywhere on the way resolves elsewhere
    if (real !== file || !real.startsWith(root + sep))
      return refuse("is a link, or leaves the checkout");
    const bytes = await readFile(file);
    if (bytes.length > PLAN_MOCKUP_BYTES_MAX) return refuse("is over 2 MB");
    const mediaType = storedMediaType(bytes);
    if (mediaType === null) return refuse("is not a picture of that type");
    if (i.known.some((secret) => secret !== "" && bytes.includes(Buffer.from(secret))))
      return refuse("holds a secret");
    staged.push({ bytes, caption, mediaType });
  }
  const dir = planAssetsDir(i.dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const mockups: PlanMockup[] = [];
  for (const { bytes, caption, mediaType } of staged) {
    const id = createHash("sha256").update(bytes).digest("hex");
    try {
      writeFileSync(join(dir, id), bytes, { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    mockups.push({ id, caption, mediaType, url: `${PLAN_ASSET_URL}${id}` });
  }
  return { ok: true, mockups };
}

/** A kept picture's bytes and type, or null when the id is not a kept picture. */
export function readPlanAsset(
  dbPath: string,
  id: string,
): { bytes: Buffer; mediaType: PlanMockup["mediaType"] } | null {
  if (!ASSET_ID.test(id)) return null;
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(planAssetsDir(dbPath), id));
  } catch {
    return null;
  }
  const mediaType = storedMediaType(bytes);
  return mediaType === null ? null : { bytes, mediaType };
}

/** Where in a review's scratch copy the signed-off mockups go. */
export const REVIEW_MOCKUP_DIR = ".mc-review/plan-mockups";
const EXT: Record<PlanMockup["mediaType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Copies each mockup into the review's scratch copy, so the reviewer can open it; returns the paths. */
export async function stageReviewMockups(
  dbPath: string,
  scratchPath: string,
  mockups: readonly PlanMockup[],
): Promise<{ path: string; caption: string }[]> {
  const staged: { path: string; caption: string }[] = [];
  if (mockups.length === 0) return staged;
  await mkdir(join(scratchPath, REVIEW_MOCKUP_DIR), { recursive: true });
  for (const [n, m] of mockups.entries()) {
    const asset = readPlanAsset(dbPath, m.id);
    if (asset === null) continue;
    const path = `${REVIEW_MOCKUP_DIR}/${n + 1}-${m.id.slice(0, 8)}.${EXT[asset.mediaType]}`;
    await writeFile(join(scratchPath, path), asset.bytes, { flag: "w", mode: 0o600 });
    staged.push({ path, caption: m.caption });
  }
  return staged;
}
