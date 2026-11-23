/**
 * Captures a web PR's screenshot pairs: every affected HUD page on main and on the PR head, both
 * rendered from Demo data (so a page the change did not touch diffs to zero), light at 1600x1000
 * unless the change is about colour or width. Only the pages that changed keep pictures.
 */
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  EVIDENCE_KINDS,
  EVIDENCE_PAGE_PATHS,
  EVIDENCE_VIEWPORT,
  EVIDENCE_WIDE_VIEWPORT,
  type EvidenceManifest,
  type EvidencePage,
  type EvidencePair,
  type EvidenceScheme,
  type EvidenceVariant,
  evidenceImageName,
  evidenceMissing,
  evidenceRefusalText,
  evidenceUncataloguedText,
  evidenceVariants,
  evidenceWidthOf,
  prEvidenceAffectedPages,
  prEvidenceUncatalogued,
  type WebPageGraph,
} from "@mc/core";
import { decodePng, diffImages } from "./png.ts";
import type { EvidenceImage, PrEvidenceStore } from "./store.ts";

/** A failed capture is tried again no sooner than this. */
export const EVIDENCE_RETRY_MS = 10 * 60_000;

/** A whole capture (two builds and every render) may take this long before it is a failure. */
export const EVIDENCE_CAPTURE_MS = 15 * 60_000;

/** A hub serving one commit's HUD on a loopback port. */
export interface EvidenceSide {
  origin: string;
  stop(): Promise<void>;
}

export interface PrEvidenceDeps {
  store: PrEvidenceStore;
  /** The one repo whose HUD this hub serves; other repos are never captured or held. */
  repoId: string;
  /** Where the database snapshot and its copies are made; removed after each capture, except a failed capture's kept snapshot, which stays until the head is captured or replaced. */
  workDir: string;
  /** The hub's own address, for the links in the PR body. */
  baseUrl: string;
  /** Whether this PR head is from the crew or a collaborator; an untrusted head is never built. */
  trusted(target: EvidenceTarget): Promise<boolean>;
  /** The commit main points at now. */
  mainSha(signal: AbortSignal): Promise<string>;
  /** Writes a consistent copy of the live database to `to`. */
  snapshot(to: string): Promise<void>;
  /** Serves `sha`'s HUD from `db`; on cancellation rejects only after cleaning owned resources. */
  startSide(input: { sha: string; db: string; signal: AbortSignal }): Promise<EvidenceSide>;
  /**
   * One screenshot of a page on a side, in Demo (simulated crew, nothing read from the hub), in a
   * colour scheme at a viewport. Both sides use it, so an untouched page is identical on both.
   */
  render(
    origin: string,
    path: string,
    scheme: EvidenceScheme,
    viewport: { width: number; height: number },
    signal: AbortSignal,
  ): Promise<Buffer>;
  /**
   * Publishes the before and after pictures of the changed pages where the PR can show them (a
   * GitHub release's files) and returns the folder URL they are under. A rejection keeps the
   * pictures on the hub only.
   */
  publish?(input: {
    pr: number;
    sha: string;
    images: readonly EvidenceImage[];
    signal: AbortSignal;
  }): Promise<string>;
  /**
   * The static import graph of `sha`'s web source, so a change is photographed on the pages that
   * reach it. A rejection (or no dep) keeps the folder rule.
   */
  webGraph?(sha: string, signal: AbortSignal): Promise<WebPageGraph>;
  retryMs?: number;
  /** The deadline of one capture; default EVIDENCE_CAPTURE_MS. */
  captureMs?: number;
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
  /** The pages the head's changes reach: the ones `ensure` photographs and `gate` waits for. */
  pages(target: EvidenceTarget): Promise<readonly EvidencePage[]>;
  /** Why the PR must stay in draft (the pages without pairs), or null when it may leave. */
  gate(target: EvidenceTarget): string | null;
  /** Cancel captures and wait for their owned hubs/worktrees to be removed. */
  stop(): Promise<void>;
}

/** One head's renders: by side, page and scheme (live), and by image name (Demo). */
interface Kept {
  sha: string;
  /** The main commit the "main" renders show. */
  mainSha: string;
  /** The database snapshot every kept render and every render still to come is taken from. */
  snapshot: string;
  shots: Map<string, Buffer>;
}

const shotKey = (side: string, page: EvidencePage, v: EvidenceVariant): string =>
  `${side}:${page}:${v.scheme}:${v.width}`;

const viewportOf = (width: number) =>
  width === EVIDENCE_WIDE_VIEWPORT.width ? EVIDENCE_WIDE_VIEWPORT : EVIDENCE_VIEWPORT;

/** Stop waiting for a read/render at cancellation. Owned side startup awaits its cleanup. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (!cancelled) resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function createPrEvidence(deps: PrEvidenceDeps): PrEvidence {
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? EVIDENCE_RETRY_MS;
  const log = deps.log ?? (() => {});
  const keyOf = (t: EvidenceTarget): string => `${t.pr}:${t.sha}`;
  /** Heads being captured, and heads whose capture failed (when). */
  const running = new Map<string, Promise<void>>();
  const failedAt = new Map<string, number>();
  /** Why the last capture of a head failed. */
  const failedWhy = new Map<string, string>();
  /** Heads whose PR-body section is written. */
  const posted = new Set<string>();
  const controllers = new Set<AbortController>();
  /**
   * Renders of a head that succeeded in an attempt that failed, so the next attempt renders only
   * what is missing. Per PR, one head at a time: a new head drops the old one's.
   */
  const kept = new Map<number, Kept>();
  /** Successfully read head graphs, plus deduplicated reads still in flight. */
  const pagesOf = new Map<string, EvidencePage[]>();
  const readingPages = new Map<string, Promise<EvidencePage[]>>();
  let stopped = false;
  /** Captures run one at a time: each builds two hubs. */
  let queue: Promise<void> = Promise.resolve();

  function manifest(t: EvidenceTarget): EvidenceManifest | null {
    const m = deps.store.manifest(deps.repoId, t.pr, t.sha);
    if (!m) return null;
    return {
      ...m,
      pairs: m.pairs.filter((p) =>
        EVIDENCE_KINDS.every((kind) =>
          deps.store.hasImage(
            deps.repoId,
            t.pr,
            t.sha,
            evidenceImageName(p.page, p.scheme, kind, evidenceWidthOf(p)),
          ),
        ),
      ),
    };
  }

  /** Renders what `shots` lacks, once more at once if a render fails, and keeps each success. */
  async function render(
    side: EvidenceSide,
    name: string,
    pages: EvidencePage[],
    variants: readonly EvidenceVariant[],
    signal: AbortSignal,
    shots: Map<string, Buffer>,
  ) {
    for (const page of pages)
      for (const v of variants) {
        const key = shotKey(name, page, v);
        if (shots.has(key)) continue;
        for (let attempt = 1; ; attempt++) {
          signal.throwIfAborted();
          try {
            shots.set(
              key,
              await abortable(
                deps.render(
                  side.origin,
                  EVIDENCE_PAGE_PATHS[page],
                  v.scheme,
                  viewportOf(v.width),
                  signal,
                ),
                signal,
              ),
            );
            break;
          } catch (e) {
            // A stopped capture says why it stopped; the page in progress did not fail.
            if (signal.aborted) throw e;
            if (attempt < 2) continue;
            // Say which render failed: the render's own message names neither page nor side.
            const why = e instanceof Error ? e.message : String(e);
            throw new Error(
              `${page} page, ${v.scheme} scheme at ${v.width}, ${name} side: ${why}`,
              { cause: e },
            );
          }
        }
      }
  }

  /** Builds one side from its own copy of the snapshot, photographs what is missing, and always stops it. */
  async function photograph(
    sha: string,
    snapshot: string,
    dir: string,
    name: string,
    pages: EvidencePage[],
    variants: readonly EvidenceVariant[],
    signal: AbortSignal,
    shots: Map<string, Buffer>,
  ): Promise<void> {
    if (pages.every((p) => variants.every((v) => shots.has(shotKey(name, p, v))))) return;
    // Each side's hub keeps its own folder: a database copy and the token file it writes beside it.
    const sideDir = join(dir, name);
    await mkdir(sideDir, { recursive: true, mode: 0o700 });
    const db = join(sideDir, `${name}.sqlite`);
    await copyFile(snapshot, db);
    signal.throwIfAborted();
    const side = await deps.startSide({ sha, db, signal });
    try {
      signal.throwIfAborted();
      await render(side, name, pages, variants, signal, shots);
    } finally {
      await side.stop().catch(() => {});
    }
  }

  /** Where a PR's kept snapshot lives: outside a capture's own folder, which is removed after it. */
  const keptDir = (pr: number): string => join(deps.workDir, `kept-${pr}`);

  async function dropKept(pr: number): Promise<void> {
    kept.delete(pr);
    await rm(keptDir(pr), { recursive: true, force: true });
  }

  async function capture(
    t: EvidenceTarget,
    pages: EvidencePage[],
    signal: AbortSignal,
  ): Promise<void> {
    const variants = evidenceVariants(t.paths);
    await mkdir(deps.workDir, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(deps.workDir, "capture-"));
    try {
      signal.throwIfAborted();
      const mainSha = await abortable(deps.mainSha(signal), signal);
      // Renders kept from a failed attempt stay, with the snapshot they were taken from, so a
      // retried page is paired with renders of the same data. Main's are stale once main moves.
      let keep = kept.get(t.pr);
      if (keep !== undefined && keep.sha !== t.sha) {
        await dropKept(t.pr);
        keep = undefined;
      }
      if (keep === undefined) {
        const keepDir = keptDir(t.pr);
        await rm(keepDir, { recursive: true, force: true });
        await mkdir(keepDir, { recursive: true, mode: 0o700 });
        const snapshot = join(keepDir, "snapshot.sqlite");
        try {
          await abortable(deps.snapshot(snapshot), signal);
        } catch (e) {
          await rm(keepDir, { recursive: true, force: true });
          throw e;
        }
        keep = { sha: t.sha, mainSha, snapshot, shots: new Map() };
        kept.set(t.pr, keep);
      } else if (keep.mainSha !== mainSha) {
        for (const k of [...keep.shots.keys()]) if (k.startsWith("main:")) keep.shots.delete(k);
        keep.mainSha = mainSha;
      }
      const snapshot = keep.snapshot;
      const shots = keep.shots;
      await photograph(mainSha, snapshot, dir, "main", pages, variants, signal, shots);
      await photograph(t.sha, snapshot, dir, "head", pages, variants, signal, shots);
      const pairs: EvidencePair[] = [];
      const images: EvidenceImage[] = [];
      const unchanged: EvidencePage[] = [];
      for (const page of pages) {
        const found: EvidencePair[] = [];
        const kinds: EvidenceImage[] = [];
        for (const v of variants) {
          const b = shots.get(shotKey("main", page, v)) as Buffer;
          const a = shots.get(shotKey("head", page, v)) as Buffer;
          const d = diffImages(decodePng(b), decodePng(a));
          found.push({
            page,
            scheme: v.scheme,
            ...(v.width === EVIDENCE_VIEWPORT.width ? {} : { width: v.width }),
            changedPixels: d.changedPixels,
            changedPercent: d.changedPercent,
            regions: d.regions,
          });
          const png = { before: b, after: a, diff: d.png };
          for (const kind of EVIDENCE_KINDS)
            kinds.push({ name: evidenceImageName(page, v.scheme, kind, v.width), png: png[kind] });
        }
        // A page that did not change in any variant keeps nothing: it is only named.
        if (found.every((p) => p.changedPixels === 0)) unchanged.push(page);
        else {
          pairs.push(...found);
          images.push(...kinds);
        }
      }
      signal.throwIfAborted();
      let published: string | undefined;
      if (deps.publish && images.length > 0) {
        try {
          published = await abortable(
            deps.publish({
              pr: t.pr,
              sha: t.sha,
              images: images.filter((i) => !i.name.endsWith("-diff.png")),
              signal,
            }),
            signal,
          );
        } catch (e) {
          if (signal.aborted) throw e;
          log(
            `#${t.pr}: pictures not published to GitHub: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      const prior = deps.store.manifest(deps.repoId, t.pr, t.sha);
      deps.store.save(
        {
          repoId: deps.repoId,
          pr: t.pr,
          sha: t.sha,
          mainSha,
          capturedAt: now(),
          pairs,
          unchanged,
          ...(published === undefined ? {} : { published: { baseUrl: published } }),
          ...(prior?.submitted ? { submitted: prior.submitted } : {}),
        },
        images,
      );
      await dropKept(t.pr);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** The pages `t` affects: by the head's import graph, else by folder. */
  async function pagesFor(t: EvidenceTarget): Promise<EvidencePage[]> {
    const key = keyOf(t);
    const known = pagesOf.get(key);
    if (known) return known;
    const byFolder = prEvidenceAffectedPages(t.paths);
    if (byFolder.length === 0 || deps.webGraph === undefined) return byFolder;
    const reading = readingPages.get(key);
    if (reading) return reading;
    const graph = deps.webGraph;
    const pending = Promise.resolve().then(async () => {
      const controller = new AbortController();
      controllers.add(controller);
      const signal = AbortSignal.any([AbortSignal.timeout(2 * 60_000), controller.signal]);
      if (stopped) controller.abort(new Error("the hub is shutting down"));
      try {
        const pages = prEvidenceAffectedPages(
          t.paths,
          await abortable(graph(t.sha, signal), signal),
        );
        pagesOf.set(key, pages);
        return pages;
      } catch (e) {
        log(
          `#${t.pr}: import graph not read, photographing by folder: ${e instanceof Error ? e.message : String(e)}`,
        );
        // A temporary failure must not fix this head to the folder fallback forever.
        return byFolder;
      } finally {
        controllers.delete(controller);
        readingPages.delete(key);
      }
    });
    readingPages.set(key, pending);
    return pending;
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
      if (stopped || t.repoId !== deps.repoId) return;
      if (!(await deps.trusted(t))) return;
      const pages = await pagesFor(t);
      if (stopped || pages.length === 0) return;
      const key = keyOf(t);
      const have = manifest(t);
      if (evidenceMissing(have, t.sha, pages, evidenceVariants(t.paths)).length === 0)
        return post(t);
      const failed = failedAt.get(key);
      if (failed !== undefined && now() - failed < retryMs) return;
      const going = running.get(key);
      if (going) return going;
      const job = queue.then(async () => {
        if (stopped) return;
        posted.delete(key);
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(
          () => controller.abort(new Error("the capture ran past its deadline")),
          deps.captureMs ?? EVIDENCE_CAPTURE_MS,
        );
        try {
          await capture(t, pages, controller.signal);
          failedAt.delete(key);
          failedWhy.delete(key);
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          failedAt.set(key, now());
          failedWhy.set(key, why);
          log(`#${t.pr}: screenshot capture failed: ${why}`);
          return;
        } finally {
          clearTimeout(timer);
          controllers.delete(controller);
        }
        if (!stopped) await post(t);
      });
      queue = job.finally(() => {});
      running.set(
        key,
        job.finally(() => running.delete(key)),
      );
      return running.get(key);
    },
    pages: pagesFor,
    gate(t) {
      if (t.repoId !== deps.repoId) return null;
      const uncatalogued = prEvidenceUncatalogued(t.paths);
      if (uncatalogued.length > 0) return evidenceUncataloguedText(uncatalogued);
      const pages = pagesOf.get(keyOf(t)) ?? prEvidenceAffectedPages(t.paths);
      if (pages.length === 0) return null;
      const have = manifest(t);
      const variants = evidenceVariants(t.paths);
      const missing = evidenceMissing(have, t.sha, pages, variants);
      if (missing.length === 0)
        return posted.has(keyOf(t))
          ? null
          : "kept in draft until its screenshot evidence links are posted to the PR";
      const why = failedWhy.get(keyOf(t));
      // A page whose renders a failed attempt kept is not missing: the next attempt skips it.
      const keep = kept.get(t.pr);
      const rendered = (page: EvidencePage): boolean =>
        keep?.sha === t.sha &&
        ["main", "head"].every((side) =>
          variants.every((v) => keep.shots.has(shotKey(side, page, v))),
        );
      const gaps = missing.filter((g) => !rendered(g.page));
      return `${evidenceRefusalText(gaps)}; capture failed: ${why ?? ""}`.replace(
        /; capture failed: $/,
        "",
      );
    },
    async stop() {
      stopped = true;
      for (const controller of controllers) controller.abort(new Error("the hub is shutting down"));
      await Promise.allSettled([...running.values(), ...readingPages.values()]);
    },
  };
}

/**
 * What the supervisor needs to hold a web review for screenshot evidence. `pages` is required, so
 * a caller cannot fall back to the folder rule: the capture and the review start check must agree
 * on what a head touches.
 */
export interface ReviewEvidenceDeps {
  store: PrEvidenceStore;
  /** The one repo whose web PRs carry screenshot pairs. */
  repoId: string;
  /** The pages the capture itself reads for a head. */
  pages(target: EvidenceTarget): Promise<readonly EvidencePage[]>;
}

export function evidenceReviewDeps(
  evidence: PrEvidence,
  store: PrEvidenceStore,
  repoId: string,
): ReviewEvidenceDeps {
  return { store, repoId, pages: (target) => evidence.pages(target) };
}
