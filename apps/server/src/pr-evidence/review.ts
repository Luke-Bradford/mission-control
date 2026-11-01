/** Puts a web PR's screenshot pairs where its reviewer can read them. */
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EVIDENCE_KINDS, type EvidencePair, evidenceImageName } from "@mc/core";
import type { PrEvidenceStore } from "./store.ts";

/** Where in a review's scratch copy the images go. */
export const REVIEW_EVIDENCE_DIR = ".mc-review/evidence";

export interface StagedEvidence {
  dir: string;
  mainSha: string;
  pairs: EvidencePair[];
}

/** Copies the head's images into the scratch copy; undefined when the head has no pairs. */
export async function stageReviewEvidence(
  store: PrEvidenceStore | undefined,
  repoId: string,
  pr: number,
  sha: string,
  scratchPath: string,
): Promise<StagedEvidence | undefined> {
  const manifest = store?.manifest(repoId, pr, sha) ?? null;
  if (store === undefined || manifest === null || manifest.pairs.length === 0) return undefined;
  await mkdir(join(scratchPath, ".mc-review"), { recursive: true });
  const stage = await mkdtemp(join(scratchPath, ".mc-review", ".evidence-"));
  try {
    for (const p of manifest.pairs) {
      for (const kind of EVIDENCE_KINDS) {
        const name = evidenceImageName(p.page, p.scheme, kind);
        const png = store.image(repoId, pr, sha, name);
        if (!png) throw new Error(`screenshot evidence image is missing: ${name}`);
        await writeFile(join(stage, name), png, { flag: "wx", mode: 0o600 });
      }
    }
    await rename(stage, join(scratchPath, REVIEW_EVIDENCE_DIR));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { dir: REVIEW_EVIDENCE_DIR, mainSha: manifest.mainSha, pairs: manifest.pairs };
}
