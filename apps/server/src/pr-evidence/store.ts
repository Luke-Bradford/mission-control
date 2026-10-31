/** Private, local storage for a web PR's screenshot pairs, one directory per head sha. */
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type EvidenceManifest, isEvidenceImageName } from "@mc/core";

/** Heads kept per PR; an older head's pairs are removed when a newer one is stored. */
export const PR_EVIDENCE_KEEP = 3;
const MANIFEST = "manifest.json";
const SHA = /^[0-9a-f]{40}$/;
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface EvidenceImage {
  name: string;
  png: Buffer;
}

export interface PrEvidenceStore {
  /** Writes the images, then the manifest: a head with no manifest does not count as captured. */
  save(manifest: EvidenceManifest, images: readonly EvidenceImage[]): void;
  /** The manifest of `sha`, or of the newest head when none is given. */
  manifest(repoId: string, pr: number, sha?: string): EvidenceManifest | null;
  image(repoId: string, pr: number, sha: string, name: string): Buffer | null;
  /** The repos that have evidence for a PR number. */
  reposWith(pr: number): string[];
}

const validPr = (pr: number): boolean => Number.isSafeInteger(pr) && pr > 0;

export function prEvidenceStore(root: string): PrEvidenceStore {
  const prDir = (repoId: string, pr: number): string | null =>
    REPO_ID.test(repoId) && validPr(pr) ? join(root, repoId, String(pr)) : null;

  const read = (dir: string): EvidenceManifest | null => {
    try {
      return JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as EvidenceManifest;
    } catch {
      return null;
    }
  };

  const heads = (dir: string): EvidenceManifest[] => {
    try {
      return readdirSync(dir)
        .filter((n) => SHA.test(n))
        .map((n) => read(join(dir, n)))
        .filter((m): m is EvidenceManifest => m !== null)
        .sort((a, b) => b.capturedAt - a.capturedAt);
    } catch {
      return [];
    }
  };

  return {
    save(manifest, images) {
      const dir = prDir(manifest.repoId, manifest.pr);
      if (dir === null || !SHA.test(manifest.sha)) throw new Error("evidence: bad repo, PR or sha");
      if (images.some((i) => !isEvidenceImageName(i.name)))
        throw new Error("evidence: bad image name");
      const head = join(dir, manifest.sha);
      mkdirSync(head, { recursive: true, mode: 0o700 });
      chmodSync(head, 0o700);
      for (const i of images) writeFileSync(join(head, i.name), i.png, { mode: 0o600 });
      const tmp = join(head, `${MANIFEST}.tmp`);
      writeFileSync(tmp, JSON.stringify(manifest), { mode: 0o600 });
      renameSync(tmp, join(head, MANIFEST));
      for (const old of heads(dir).slice(PR_EVIDENCE_KEEP))
        rmSync(join(dir, old.sha), { recursive: true, force: true });
    },
    manifest(repoId, pr, sha) {
      const dir = prDir(repoId, pr);
      if (dir === null) return null;
      if (sha === undefined) return heads(dir)[0] ?? null;
      return SHA.test(sha) ? read(join(dir, sha)) : null;
    },
    image(repoId, pr, sha, name) {
      const dir = prDir(repoId, pr);
      if (dir === null || !SHA.test(sha) || !isEvidenceImageName(name)) return null;
      try {
        return readFileSync(join(dir, sha, name));
      } catch {
        return null;
      }
    },
    reposWith(pr) {
      if (!validPr(pr)) return [];
      try {
        return readdirSync(root).filter(
          (repoId) => REPO_ID.test(repoId) && heads(join(root, repoId, String(pr))).length > 0,
        );
      } catch {
        return [];
      }
    },
  };
}
