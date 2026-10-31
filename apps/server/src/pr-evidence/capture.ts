/**
 * Captures a web PR's screenshot pairs: every affected HUD page at 1600x1000, light and dark, on
 * main and on the PR head, both rendered from copies of one snapshot of the live database.
 */
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  EVIDENCE_KINDS,
  EVIDENCE_SCHEMES,
  type EvidenceManifest,
  type EvidencePage,
  type EvidencePair,
  type EvidenceScheme,
  evidenceImageName,
  evidenceMissing,
  evidenceRefusalText,
  HUD_PAGE_PATHS,
  prEvidenceAffectedPages,
} from "@mc/core";
import { decodePng, diffImages } from "./png.ts";
import type { EvidenceImage, PrEvidenceStore } from "./store.ts";

/** A failed capture is tried again no sooner than this. */
export const EVIDENCE_RETRY_MS = 10 * 60_000;

/** A hub serving one commit's HUD on a loopback port. */
export interface EvidenceSide {
  origin: string;
  stop(): Promise<void>;
}

export interface PrEvidenceDeps {
  store: PrEvidenceStore;
  /** The one repo whose HUD this hub serves; other repos are never captured or held. */
  repoId: string;
  /** Where the database snapshot and its copies are made; removed after each capture. */
  workDir: string;
  /** The hub's own address, for the links in the PR body. */
  baseUrl: string;
  /** The commit main points at now. */
  mainSha(): Promise<string>;
  /** Writes a consistent copy of the live database to `to`. */
  snapshot(to: string): Promise<void>;
  /** Serves `sha`'s HUD from the database at `db` until `stop`. */
  startSide(input: { sha: string; db: string }): Promise<EvidenceSide>;
  /** One screenshot of a page on a side, in a colour scheme. */
  render(origin: string, path: string, scheme: EvidenceScheme): Promise<Buffer>;
  retryMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** A PR head and the files it changes. */
export interface EvidenceTarget {
  repoId: string;
  pr: number;
  sha: string;
  paths: readonly string[];
  /** Called once the head's pairs are stored; a failure is retried on the next `ensure`. */
  onStored?(manifest: EvidenceManifest): Promise<void>;
}

export interface PrEvidence {
  /** The hub's own address, for the links in the PR body. */
  readonly baseUrl: string;
  /** Captures the head's pairs if it needs them and has none; never rejects. */
  ensure(target: EvidenceTarget): Promise<void>;
  /** Why the PR must stay in draft (the pages without pairs), or null when it may leave. */
  gate(target: EvidenceTarget): string | null;
}

export function createPrEvidence(deps: PrEvidenceDeps): PrEvidence {
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? EVIDENCE_RETRY_MS;
  const log = deps.log ?? (() => {});
  const keyOf = (t: EvidenceTarget): string => `${t.pr}:${t.sha}`;
  /** Heads being captured, and heads whose capture failed (when). */
  const running = new Map<string, Promise<void>>();
  const failedAt = new Map<string, number>();
  /** Heads whose PR-body section is written. */
  const posted = new Set<string>();
  /** Captures run one at a time: each builds two hubs. */
  let queue: Promise<void> = Promise.resolve();

  async function render(side: EvidenceSide, pages: EvidencePage[]) {
    const shots = new Map<string, Buffer>();
    for (const page of pages)
      for (const scheme of EVIDENCE_SCHEMES)
        shots.set(
          `${page}:${scheme}`,
          await deps.render(side.origin, HUD_PAGE_PATHS[page], scheme),
        );
    return shots;
  }

  /** Builds one side from its own copy of the snapshot, photographs it, and always stops it. */
  async function photograph(
    sha: string,
    snapshot: string,
    dir: string,
    name: string,
    pages: EvidencePage[],
  ): Promise<Map<string, Buffer>> {
    const db = join(dir, `${name}.sqlite`);
    await copyFile(snapshot, db);
    const side = await deps.startSide({ sha, db });
    try {
      return await render(side, pages);
    } finally {
      await side.stop().catch(() => {});
    }
  }

  async function capture(t: EvidenceTarget, pages: EvidencePage[]): Promise<void> {
    await mkdir(deps.workDir, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(deps.workDir, "capture-"));
    try {
      const mainSha = await deps.mainSha();
      const snapshot = join(dir, "snapshot.sqlite");
      await deps.snapshot(snapshot);
      const before = await photograph(mainSha, snapshot, dir, "main", pages);
      const after = await photograph(t.sha, snapshot, dir, "head", pages);
      const pairs: EvidencePair[] = [];
      const images: EvidenceImage[] = [];
      for (const page of pages) {
        for (const scheme of EVIDENCE_SCHEMES) {
          const key = `${page}:${scheme}`;
          const b = before.get(key) as Buffer;
          const a = after.get(key) as Buffer;
          const d = diffImages(decodePng(b), decodePng(a));
          pairs.push({
            page,
            scheme,
            changedPixels: d.changedPixels,
            changedPercent: d.changedPercent,
            regions: d.regions,
          });
          const png = { before: b, after: a, diff: d.png };
          for (const kind of EVIDENCE_KINDS)
            images.push({ name: evidenceImageName(page, scheme, kind), png: png[kind] });
        }
      }
      deps.store.save(
        { repoId: deps.repoId, pr: t.pr, sha: t.sha, mainSha, capturedAt: now(), pairs },
        images,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function post(t: EvidenceTarget): Promise<void> {
    const manifest = deps.store.manifest(deps.repoId, t.pr, t.sha);
    if (manifest === null || posted.has(keyOf(t)) || t.onStored === undefined) return;
    try {
      await t.onStored(manifest);
      posted.add(keyOf(t));
    } catch (e) {
      log(`#${t.pr}: evidence not posted to the PR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    baseUrl: deps.baseUrl,
    async ensure(t) {
      if (t.repoId !== deps.repoId) return;
      const pages = prEvidenceAffectedPages(t.paths);
      if (pages.length === 0) return;
      const key = keyOf(t);
      const have = deps.store.manifest(deps.repoId, t.pr, t.sha);
      if (evidenceMissing(have, t.sha, pages).length === 0) return post(t);
      const failed = failedAt.get(key);
      if (failed !== undefined && now() - failed < retryMs) return;
      const going = running.get(key);
      if (going) return going;
      const job = queue.then(async () => {
        try {
          await capture(t, pages);
          failedAt.delete(key);
        } catch (e) {
          failedAt.set(key, now());
          log(`#${t.pr}: screenshot capture failed: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        await post(t);
      });
      queue = job.finally(() => {});
      running.set(
        key,
        job.finally(() => running.delete(key)),
      );
      return running.get(key);
    },
    gate(t) {
      if (t.repoId !== deps.repoId) return null;
      const pages = prEvidenceAffectedPages(t.paths);
      if (pages.length === 0) return null;
      const missing = evidenceMissing(deps.store.manifest(deps.repoId, t.pr, t.sha), t.sha, pages);
      return missing.length === 0 ? null : evidenceRefusalText(missing);
    },
  };
}
