/** Puts a web PR's screenshot pairs where its reviewer can read them. */
import { mkdir, writeFile } from "node:fs/promises";
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
  await mkdir(join(scratchPath, REVIEW_EVIDENCE_DIR), { recursive: true });
  for (const p of manifest.pairs) {
    for (const kind of EVIDENCE_KINDS) {
      const name = evidenceImageName(p.page, p.scheme, kind);
      const png = store.image(repoId, pr, sha, name);
      if (png) await writeFile(join(scratchPath, REVIEW_EVIDENCE_DIR, name), png);
    }
  }
  return { dir: REVIEW_EVIDENCE_DIR, mainSha: manifest.mainSha, pairs: manifest.pairs };
}
