/** Immutable QA JSON and retained assets. Reads never reconstruct an approval from current state. */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BLOCKING_SEVERITIES,
  EVIDENCE_KINDS,
  evidenceImageName,
  FINDING_CATEGORIES,
  FINDING_RESOLUTION_OUTCOMES,
  FINDING_SEVERITIES,
  type FindingResolution,
  prEvidenceAffectedPages,
  type QaImageRef,
  type QaReport,
  type QaTestReceipt,
  type QaVisualEvidence,
  qaReportPermalink,
  REVIEW_CHECK_IDS,
  REVIEW_CHECK_RESULTS,
  type ReportedTest,
  type ReviewCheck,
  type ReviewFinding,
  type ReviewRow,
  type ReviewVerdict,
  scanText,
} from "@mc/core";
import { z } from "zod";
import { parseChecks } from "./collectors/github.ts";
import type { CcConfig } from "./config.ts";
import type { HudShotStore } from "./flight/hud-store.ts";
import type { GhRunner } from "./mcp/gh.ts";
import type { PrEvidenceStore } from "./pr-evidence/store.ts";
import type { Store } from "./store.ts";

export const QA_REPORT_BODY_LIMIT = 256 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const IMAGE_BYTES_MAX = 8 * 1024 * 1024;
const REPORT_IMAGE_BYTES_MAX = 64 * 1024 * 1024;
export const QA_REPORT_ID = /^[a-f0-9]{64}$/;
const text = (max = 4000) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) =>
      Array.from(value).every((char) => {
        const code = char.charCodeAt(0);
        return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
      }),
    );
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const finding = z.strictObject({
  severity: z.enum(FINDING_SEVERITIES),
  file: text(400),
  line: z.int().min(0).max(1_000_000),
  summary: text(),
  scenario: text(),
  fix: text(),
  category: z.enum(FINDING_CATEGORIES).optional(),
});
const resolution = z.strictObject({
  findingRef: z.strictObject({ reviewId: z.int().positive(), pos: z.int().nonnegative() }),
  outcome: z.enum(FINDING_RESOLUTION_OUTCOMES),
});
const coverage = z.strictObject({
  check: z.enum(REVIEW_CHECK_IDS),
  result: z.enum(REVIEW_CHECK_RESULTS),
  note: text().optional(),
});
const followUp = z.strictObject({
  text: text(),
  disposition: z.enum(["fixed", "ticket", "accepted", "pending"]),
  ticket: text(500).optional(),
  basis: text().optional(),
});
const image = z.strictObject({
  url: text(1500),
  sourceUrl: text(1500).optional(),
  source: z.enum(["native-capture", "controlled-fixture", "controller-link"]),
  sha256: z.string().regex(QA_REPORT_ID).optional(),
  capturedAt: timestamp.nullable().optional(),
  commitSha: z.string().regex(SHA).optional(),
  provenance: text().optional(),
});
const visual = z.strictObject({
  applicability: z.enum(["required", "not_applicable", "unknown"]),
  reason: text().optional(),
  pairs: z
    .array(
      z.strictObject({ label: text(300), before: image, after: image, diff: image.optional() }),
    )
    .max(80),
  screenshots: z
    .array(image.extend({ label: text(300) }))
    .max(100)
    .optional(),
});
const receipt = z.strictObject({
  command: text(4000),
  origin: z.enum(["reviewer-reported", "controller-recorded"]),
  outcome: z.enum(["passed", "failed", "not-run", "unknown"]),
  at: timestamp.nullable().optional(),
  exitCode: z.int().min(-255).max(65535).nullable().optional(),
  passed: z.int().nonnegative().max(10_000_000).optional(),
  failed: z.int().nonnegative().max(10_000_000).optional(),
  skipped: z.int().nonnegative().max(10_000_000).optional(),
  duration: z.int().nonnegative().optional(),
  evidence: text(12000).optional(),
  file: text(400).optional(),
});
export const QaReportImportSchema = z.strictObject({
  repoId: text(200),
  prNumber: z.int().positive(),
  headSha: z.string().regex(SHA),
  reviewer: z.strictObject({ id: text(200), label: text(200), model: text(200).optional() }),
  reviewedAt: timestamp.nullable(),
  sourceRef: text(1500),
  verdict: z.strictObject({ spec: z.enum(["pass", "fail"]), quality: z.enum(["pass", "fail"]) }),
  summary: text(8000),
  worksWell: z.array(text()).max(50).optional(),
  coverage: z.array(coverage).max(REVIEW_CHECK_IDS.length).optional(),
  findings: z.array(finding).max(100).optional(),
  resolutions: z.array(resolution).max(100).optional(),
  tests: z.array(receipt).max(100).optional(),
  limitations: z.array(text()).max(100).optional(),
  followUps: z.array(followUp).max(100).optional(),
  visual: visual.optional(),
});

export interface NativeQaDetails {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  checked?: ReviewCheck[];
  tests?: ReportedTest[];
  resolutions?: FindingResolution[];
  worksWell?: string[];
  limitations?: string[];
  followUps?: QaReport["followUps"];
  visualReason?: string;
}
export interface QaReportService {
  prepareNative(review: ReviewRow, details: NativeQaDetails, at: number): Promise<QaReport>;
  importController(input: unknown): Promise<{ report: QaReport; created: boolean }>;
  read(id: string): QaReport | null;
  list(repoId: string, pr: number, head?: string): QaReport[];
  asset(id: string): Buffer | null;
}
export class QaReportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Check declared review facts; do not infer design quality or manufacture a finding. */
function validateDesignVerdict(
  verdict: ReviewVerdict,
  findings: readonly ReviewFinding[],
  coverage: readonly ReviewCheck[],
): void {
  if (!coverage.some((check) => check.check === "design" && check.result === "fail")) return;
  if (
    (verdict.spec === "fail" || verdict.quality === "fail") &&
    findings.some((finding) => BLOCKING_SEVERITIES.includes(finding.severity))
  )
    return;
  throw new QaReportError(
    400,
    "A failed design check requires a failing verdict and at least one Critical or Important finding. Record the observed defect before submitting.",
  );
}

/** Sorted keys give the same content address regardless of object construction order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function createQaReports(i: {
  store: Store;
  config: CcConfig;
  gh: GhRunner;
  cwd: string;
  knownSecrets: () => Promise<readonly string[]>;
  assetsDir?: string;
  evidence?: PrEvidenceStore;
  reviewShots?: HudShotStore;
  now?: () => number;
  secretsTimeoutMs?: number;
}): QaReportService {
  const now = i.now ?? Date.now;
  const assetsDir = i.assetsDir ?? join(dirname(i.store.path), "qa-report-assets");
  async function secrets(): Promise<readonly string[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        i.knownSecrets(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), i.secretsTimeoutMs ?? 5000);
        }),
      ]);
    } catch {
      throw new QaReportError(
        503,
        "QA report not saved: the secret scan is unavailable. Retry when credentials can be read.",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  function safe(value: unknown, known: readonly string[]) {
    // Scan each raw string before JSON escaping; never write or echo rejected data.
    const visit = (v: unknown): boolean =>
      typeof v === "string"
        ? scanText("QA report", v, known).length > 0
        : Array.isArray(v)
          ? v.some(visit)
          : v !== null && typeof v === "object"
            ? Object.entries(v).some(([k, x]) => visit(k) || visit(x))
            : false;
    if (visit(value))
      throw new QaReportError(
        400,
        "QA report not saved: it contains a secret. Remove it and retry.",
      );
  }
  function retain(png: Buffer, known: readonly string[]): string {
    if (
      png.length > IMAGE_BYTES_MAX ||
      png.length < 8 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new QaReportError(400, "QA image is missing or is not a bounded PNG.");
    if (known.some((secret) => secret && png.includes(Buffer.from(secret))))
      throw new QaReportError(400, "QA image contains secret metadata.");
    const id = createHash("sha256").update(png).digest("hex");
    mkdirSync(assetsDir, { recursive: true, mode: 0o700 });
    chmodSync(assetsDir, 0o700);
    try {
      writeFileSync(join(assetsDir, `${id}.png`), png, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return id;
  }
  function nativeVisual(
    review: Pick<ReviewRow, "repoId" | "prNumber" | "sha"> & { id?: number },
    reason: string | undefined,
    known: readonly string[],
  ): QaVisualEvidence {
    const manifest = i.evidence?.manifest(review.repoId, review.prNumber, review.sha);
    const pr = i.store.pullRequest(review.repoId, review.prNumber);
    const paths = i.store.prFilePaths(review.repoId, review.prNumber);
    const knownWeb = prEvidenceAffectedPages(paths).length > 0;
    const completePaths =
      pr?.headSha === review.sha && pr.changedFiles != null && pr.changedFiles === paths.length;
    const result: QaVisualEvidence = {
      applicability:
        manifest || knownWeb ? "required" : reason && completePaths ? "not_applicable" : "unknown",
      ...(reason ? { reason } : {}),
      pairs: [],
    };
    if (
      manifest &&
      manifest.sha === review.sha &&
      manifest.repoId === review.repoId &&
      manifest.pr === review.prNumber
    ) {
      safe(manifest, known);
      result.manifest = manifest;
      const provenance = (manifest as unknown as { provenance?: unknown }).provenance;
      const reconstructed =
        provenance !== undefined && /fixture|reconstruct/i.test(canonical(provenance));
      for (const pair of manifest.pairs) {
        const images = EVIDENCE_KINDS.map((kind) => {
          const png = i.evidence?.image(
            review.repoId,
            review.prNumber,
            review.sha,
            evidenceImageName(pair.page, pair.scheme, kind),
          );
          if (!png) return null;
          const hash = retain(png, known);
          return {
            url: `/api/qa-report-assets/${hash}`,
            sha256: hash,
            source: reconstructed ? ("controlled-fixture" as const) : ("native-capture" as const),
            capturedAt: manifest.capturedAt,
            commitSha: kind === "before" ? manifest.mainSha : manifest.sha,
            provenance: reconstructed
              ? `Retained capture provenance: ${canonical(provenance)}`
              : "Native before/after capture on the same preview data.",
          };
        });
        const [before, after, diff] = images;
        if (before && after)
          result.pairs.push({
            label: `${pair.page}, ${pair.scheme}`,
            before,
            after,
            ...(diff ? { diff } : {}),
          });
      }
    }
    result.screenshots = (review.id === undefined ? [] : i.store.reviewShots(review.id)).flatMap(
      (shot) => {
        const png = i.reviewShots?.read(shot.id);
        if (!png) return [];
        const hash = retain(png, known);
        return [
          {
            label: `${shot.label} (${shot.width}px, ${shot.theme})`,
            url: `/api/qa-report-assets/${hash}`,
            sha256: hash,
            source: "native-capture" as const,
            capturedAt: shot.at,
            commitSha: review.sha,
            provenance: "Review preview browser capture; not a before/after pair.",
          },
        ];
      },
    );
    return result;
  }
  function finish(
    base: Omit<QaReport, "id" | "permalink" | "completeness">,
    present: { limitations: boolean; followUps: boolean },
    known: readonly string[],
  ): QaReport {
    const missing: string[] = [];
    if (!base.worksWell.length) missing.push("Works-well observations were not recorded.");
    if (!base.coverage.length) missing.push("Checklist coverage was not recorded.");
    if (base.visual.applicability === "required") {
      const browser = base.coverage.find((check) => check.check === "browser");
      const design = base.coverage.find((check) => check.check === "design");
      if (!browser) missing.push("Browser coverage was not recorded for this visual change.");
      else if (browser.result === "n-a")
        missing.push("Browser rendering was not performed for this visual change.");
      if (!design) missing.push("Design coverage was not recorded for this visual change.");
      else {
        if (design.result === "n-a")
          missing.push("Design review was not performed for this visual change.");
        if (!design.note?.trim())
          missing.push("Design observations were not recorded for this visual change.");
      }
    }
    if (
      !base.tests.some(
        (test) =>
          test.origin === "hub-receipt" ||
          (test.origin === "controller-recorded" &&
            test.evidence &&
            test.at != null &&
            test.exitCode != null),
      )
    )
      missing.push(
        "Test execution receipts were not recorded; reviewer counts remain reported claims.",
      );
    if (!present.limitations) missing.push("Limitations were not recorded.");
    if (!present.followUps) missing.push("Follow-up disposition was not recorded.");
    if (
      base.followUps.some(
        (item) => item.disposition === "pending" || (item.disposition === "ticket" && !item.ticket),
      )
    )
      missing.push("A follow-up still needs a disposition or ticket.");
    if (
      base.visual.applicability === "unknown" ||
      (base.visual.applicability === "not_applicable" && !base.visual.reason) ||
      (base.visual.applicability === "required" && !base.visual.pairs.length)
    )
      missing.push("Before/after evidence or a visual applicability reason is missing.");
    if (
      base.visual.manifest &&
      base.visual.manifest.pairs.some(
        (pair) =>
          !base.visual.pairs.some(
            (saved) =>
              saved.label === `${pair.page}, ${pair.scheme}` &&
              saved.before.url.startsWith("/api/qa-report-assets/") &&
              saved.after.url.startsWith("/api/qa-report-assets/"),
          ),
      )
    )
      missing.push("Some native before/after images were unavailable for retention.");
    if (base.ci.source === "unavailable" || !base.ci.checks.length)
      missing.push("CI gate receipts are unavailable.");
    if (base.ci.source === "hub-cache")
      missing.push("CI was observed in the hub cache, not freshly verified with GitHub.");
    if (base.reviewedAt === null) missing.push("The exact original review time is unknown.");
    const content = {
      ...base,
      completeness: {
        state: missing.length ? ("incomplete" as const) : ("complete" as const),
        missing,
      },
    };
    safe(content, known);
    if (Buffer.byteLength(canonical(content)) > QA_REPORT_BODY_LIMIT)
      throw new QaReportError(400, "QA report is too large. Shorten the evidence and retry.");
    const id = createHash("sha256").update(canonical(content)).digest("hex");
    return { ...content, id, permalink: qaReportPermalink(base.repoId, base.prNumber, id) };
  }
  async function githubCi(
    github: string,
    pr: number,
    sha: string,
    strictHead: boolean,
  ): Promise<QaReport["ci"]> {
    const unavailable = (limitation: string): QaReport["ci"] => ({
      observedAt: now(),
      headSha: sha,
      source: "unavailable",
      checks: [],
      limitation,
    });
    try {
      const reply = await i.gh(
        ["pr", "view", String(pr), `--repo=${github}`, "--json=headRefOid,statusCheckRollup"],
        { cwd: i.cwd, timeoutMs: 5000, maxBuffer: 256 * 1024 },
      );
      if (reply.code !== 0)
        return unavailable("Fresh GitHub CI receipts could not be read at report registration.");
      const facts = JSON.parse(reply.stdout) as {
        headRefOid?: unknown;
        statusCheckRollup?: unknown;
      };
      if (facts.headRefOid !== sha) {
        if (strictHead)
          throw new QaReportError(409, "The PR head changed while its CI receipts were read.");
        return unavailable(
          "The current PR head no longer matches this native review; no current CI was attributed to the older head.",
        );
      }
      if (!Array.isArray(facts.statusCheckRollup))
        return unavailable("GitHub returned incomplete CI receipts.");
      const checks = parseChecks({ contexts: { nodes: facts.statusCheckRollup } });
      return checks.length === facts.statusCheckRollup.length
        ? { observedAt: now(), headSha: sha, source: "github", checks }
        : unavailable("Some GitHub CI receipt shapes were unreadable.");
    } catch (error) {
      if (error instanceof QaReportError) throw error;
      return unavailable("Fresh GitHub CI receipts were unavailable at registration.");
    }
  }
  function readReport(id: string): QaReport | null {
    if (!QA_REPORT_ID.test(id)) return null;
    const report = i.store.qaReport(id);
    if (
      !report ||
      report.id !== id ||
      report.permalink !== qaReportPermalink(report.repoId, report.prNumber, id) ||
      !i.config.repos.some((repo) => repo.id === report.repoId && repo.github === report.github)
    )
      return null;
    const { id: _id, permalink: _permalink, ...content } = report;
    return createHash("sha256").update(canonical(content)).digest("hex") === id ? report : null;
  }
  return {
    read: readReport,
    list: (repo, pr, head) =>
      i.store.qaReports(repo, pr, head).flatMap((report) => {
        const verified = readReport(report.id);
        return verified ? [verified] : [];
      }),
    asset(id) {
      if (!QA_REPORT_ID.test(id)) return null;
      if (
        !i.store.qaAssetReferenced(
          id,
          i.config.repos.map((repo) => repo.id),
        )
      )
        return null;
      try {
        const png = readFileSync(join(assetsDir, `${id}.png`));
        return createHash("sha256").update(png).digest("hex") === id ? png : null;
      } catch {
        return null;
      }
    },
    async prepareNative(review, details, at) {
      validateDesignVerdict(details.verdict, details.findings, details.checked ?? []);
      const known = await secrets();
      safe(details, known);
      const repo = i.config.repos.find((repo) => repo.id === review.repoId);
      if (!repo) throw new QaReportError(400, "QA report repository is not configured.");
      const pr = i.store.pullRequest(review.repoId, review.prNumber);
      const run = i.store.run(review.runId ?? "");
      const checks = i.store.qaCheckReceipts(review.runId ?? "", review.sha);
      const tests: QaTestReceipt[] = [
        ...checks.map((check) => ({
          command: check.command,
          origin: "hub-receipt" as const,
          outcome:
            check.ok == null
              ? ("unknown" as const)
              : check.ok
                ? ("passed" as const)
                : ("failed" as const),
          at: check.at,
          exitCode: check.exitCode,
          evidence: check.evidence,
        })),
        ...(details.tests ?? []).map((test) => ({
          ...test,
          origin: "reviewer-reported" as const,
          outcome: test.failed ? ("failed" as const) : ("passed" as const),
        })),
      ];
      return finish(
        {
          schemaVersion: 1,
          repoId: repo.id,
          github: repo.github,
          prNumber: review.prNumber,
          headSha: review.sha,
          prTitle: pr?.title ?? `PR #${review.prNumber}`,
          prUrl: `https://github.com/${repo.github}/pull/${review.prNumber}`,
          ...(pr?.headSha === review.sha ? { branch: pr.branch } : {}),
          source: "native",
          reviewer: {
            id: review.seatId,
            label: review.seatId,
            ...(run?.model ? { model: run.model } : {}),
          },
          reviewedAt: at,
          registeredAt: at,
          nativeReviewId: review.id,
          ...(review.runId ? { nativeRunId: review.runId } : {}),
          verdict: details.verdict,
          summary: details.summary,
          worksWell: details.worksWell ?? [],
          coverage: details.checked ?? [],
          findings: details.findings,
          resolutions: details.resolutions ?? [],
          tests,
          ci: await githubCi(repo.github, review.prNumber, review.sha, false),
          limitations: details.limitations ?? [],
          followUps: details.followUps ?? [],
          visual: nativeVisual(review, details.visualReason, known),
        },
        {
          limitations: details.limitations !== undefined,
          followUps: details.followUps !== undefined,
        },
        known,
      );
    },
    async importController(raw) {
      const imageDeadline = Date.now() + 60_000;
      const parsed = QaReportImportSchema.safeParse(raw);
      if (!parsed.success)
        throw new QaReportError(
          400,
          "Invalid QA report. Check the bounded report fields and retry.",
        );
      const input = parsed.data;
      if (
        new Set(input.coverage?.map((check) => check.check)).size !== (input.coverage?.length ?? 0)
      )
        throw new QaReportError(400, "Each checklist item may appear once.");
      validateDesignVerdict(input.verdict, input.findings ?? [], input.coverage ?? []);
      if (
        input.findings?.some((finding) => finding.severity !== "Minor") &&
        input.verdict.spec === "pass" &&
        input.verdict.quality === "pass"
      )
        throw new QaReportError(400, "Blocking findings require a failing recorded verdict.");
      const known = await secrets();
      safe(input, known);
      const repo = i.config.repos.find((repo) => repo.id === input.repoId);
      if (!repo) throw new QaReportError(404, "Unknown QA repository.");
      if (input.reviewedAt !== null && input.reviewedAt > now() + 60_000)
        throw new QaReportError(400, "The review time cannot be in the future.");
      let source: URL;
      try {
        source = new URL(input.sourceRef);
      } catch {
        throw new QaReportError(400, "Give the source review or comment permalink on this PR.");
      }
      const sourcePath = `/` + repo.github + `/pull/${input.prNumber}`;
      if (
        source.origin !== "https://github.com" ||
        source.username ||
        source.password ||
        !(source.pathname === sourcePath || source.pathname.startsWith(`${sourcePath}/`))
      )
        throw new QaReportError(400, "Give the source review or comment permalink on this PR.");
      const images = [
        ...(input.visual?.pairs.flatMap((pair) => [
          pair.before,
          pair.after,
          ...(pair.diff ? [pair.diff] : []),
        ]) ?? []),
        ...(input.visual?.screenshots ?? []),
      ];
      for (const image of images.flatMap((image) => [
        image,
        ...(image.sourceUrl ? [{ ...image, url: image.sourceUrl }] : []),
      ])) {
        if (image.source === "native-capture")
          throw new QaReportError(
            400,
            "Controller image links must name their controller or controlled-fixture provenance.",
          );
        let url: URL;
        try {
          url = new URL(image.url);
        } catch {
          throw new QaReportError(400, "QA image links must use immutable GitHub commit PNG URLs.");
        }
        const parts = url.pathname.split("/");
        const [owner, name] = repo.github.split("/");
        const shaAt =
          url.hostname === "raw.githubusercontent.com"
            ? 3
            : url.hostname === "github.com" && ["blob", "raw"].includes(parts[3] ?? "")
              ? 4
              : -1;
        let canonicalPath = false;
        try {
          const path = parts.slice(shaAt + 1);
          canonicalPath =
            path.length > 0 &&
            path.every((part) => {
              const decoded = decodeURIComponent(part);
              return (
                decoded !== "." &&
                decoded !== ".." &&
                decoded.length > 0 &&
                !/[\\/]/.test(decoded) &&
                [...decoded].every(
                  (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
                ) &&
                encodeURIComponent(decoded) === part
              );
            });
        } catch {
          /* Refuse malformed percent encoding. */
        }
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          parts[1] !== owner ||
          parts[2] !== name ||
          shaAt < 0 ||
          !SHA.test(parts[shaAt] ?? "") ||
          !url.pathname.endsWith(".png") ||
          url.href !== image.url ||
          !canonicalPath ||
          !image.provenance
        )
          throw new QaReportError(
            400,
            "QA images need same-repo immutable commit PNG links and capture provenance.",
          );
      }
      // GitHub blob pages contain HTML. Persist a PNG endpoint for rendering and keep the page
      // link as provenance. All original targets, including sourceUrl, were validated above.
      for (const image of images) {
        const url = new URL(image.url);
        if (url.hostname === "github.com") {
          image.sourceUrl ??= image.url;
          const parts = url.pathname.split("/");
          image.url = `https://raw.githubusercontent.com/${parts.slice(1, 3).join("/")}/${parts.slice(4).join("/")}`;
        }
      }
      const result = await i.gh(["api", `repos/${repo.github}/pulls/${input.prNumber}`], {
        cwd: i.cwd,
        timeoutMs: 5000,
        maxBuffer: 256 * 1024,
      });
      if (result.code !== 0)
        throw new QaReportError(
          502,
          "The exact PR head could not be verified. Retry when GitHub is available.",
        );
      let pr: {
        number?: unknown;
        title?: unknown;
        head?: { sha?: unknown; ref?: unknown };
        base?: { repo?: { full_name?: unknown } };
      };
      try {
        pr = JSON.parse(result.stdout);
      } catch {
        throw new QaReportError(502, "GitHub returned incomplete PR evidence.");
      }
      if (
        pr?.number !== input.prNumber ||
        pr.head?.sha !== input.headSha ||
        pr.base?.repo?.full_name !== repo.github ||
        typeof pr.title !== "string"
      )
        throw new QaReportError(
          409,
          "The PR head or repository changed. Reload its evidence before registering this report.",
        );
      const at = now();
      const ci = await githubCi(repo.github, input.prNumber, input.headSha, true);
      const retained = nativeVisual(
        { repoId: repo.id, prNumber: input.prNumber, sha: input.headSha },
        input.visual?.reason,
        known,
      );
      const linked = (image: QaImageRef, kind: "before" | "after" | "diff"): QaImageRef => {
        const portable = input.visual?.pairs
          .map((pair) => pair[kind])
          .find((source) => source?.sha256 !== undefined && source.sha256 === image.sha256);
        return portable ? { ...image, sourceUrl: portable.sourceUrl ?? portable.url } : image;
      };
      const localPairs = retained.pairs.map((pair) => ({
        ...pair,
        before: linked(pair.before, "before"),
        after: linked(pair.after, "after"),
        ...(pair.diff ? { diff: linked(pair.diff, "diff") } : {}),
      }));
      const retainedByHash = new Map(
        localPairs.flatMap((pair) =>
          [pair.before, pair.after, ...(pair.diff ? [pair.diff] : [])].flatMap((image) =>
            image.sha256 ? [[image.sha256, image] as const] : [],
          ),
        ),
      );
      let imageBytes = [...retainedByHash.keys()].reduce(
        (total, hash) => total + statSync(join(assetsDir, `${hash}.png`)).size,
        0,
      );
      const imageFailure = () =>
        new QaReportError(
          400,
          "QA report not saved: a bounded immutable Git PNG could not be retained. Check its path, hash and repository access.",
        );
      if (imageBytes > REPORT_IMAGE_BYTES_MAX) throw imageFailure();
      const fetched = new Map<string, { url: string; sha256: string }>();
      const readGit = async (endpoint: string, maxBuffer: number) => {
        const remaining = imageDeadline - Date.now();
        if (remaining <= 0) throw imageFailure();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            i.gh(
              [
                "api",
                endpoint,
                "--method",
                "GET",
                "-H",
                endpoint.includes("/git/blobs/")
                  ? "Accept: application/vnd.github+json"
                  : "Accept: application/vnd.github.object+json",
              ],
              {
                cwd: i.cwd,
                timeoutMs: Math.min(5000, remaining),
                maxBuffer,
              },
            ),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(imageFailure()), Math.min(5000, remaining));
            }),
          ]);
          if (result.code !== 0 || Buffer.byteLength(result.stdout) > maxBuffer)
            throw imageFailure();
          const parsed: unknown = JSON.parse(result.stdout);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
            throw imageFailure();
          return parsed as Record<string, unknown>;
        } catch {
          throw imageFailure();
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const archiveImage = async (image: QaImageRef): Promise<QaImageRef> => {
        const cached = fetched.get(image.url);
        if (cached) {
          if (image.sha256 && image.sha256 !== cached.sha256) throw imageFailure();
          return { ...image, ...cached, sourceUrl: image.sourceUrl ?? image.url };
        }
        const local = image.sha256 ? retainedByHash.get(image.sha256) : undefined;
        if (local?.sha256) {
          const saved = { url: local.url, sha256: local.sha256 };
          fetched.set(image.url, saved);
          return { ...image, ...saved, sourceUrl: image.sourceUrl ?? image.url };
        }
        const url = new URL(image.url),
          parts = url.pathname.split("/");
        // Every input is already normalized and validated against this configured repository.
        const commitSha = parts[3] as string;
        const path = parts
          .slice(4)
          .map((part) => decodeURIComponent(part))
          .join("/");
        const endpoint = `repos/${repo.github}/contents/${parts.slice(4).join("/")}?ref=${commitSha}`;
        const metadata = await readGit(endpoint, 2 * 1024 * 1024);
        const size = metadata.size,
          blobSha = metadata.sha;
        if (
          metadata.type !== "file" ||
          metadata.path !== path ||
          metadata.submodule_git_url != null ||
          metadata.target != null ||
          typeof size !== "number" ||
          !Number.isSafeInteger(size) ||
          size < 8 ||
          size > IMAGE_BYTES_MAX ||
          typeof blobSha !== "string" ||
          !SHA.test(blobSha) ||
          imageBytes + size > REPORT_IMAGE_BYTES_MAX
        )
          throw imageFailure();
        let content = metadata;
        if (metadata.encoding === "none" && metadata.content === "") {
          content = await readGit(
            `repos/${repo.github}/git/blobs/${blobSha}`,
            Math.ceil(IMAGE_BYTES_MAX * 1.4) + 64 * 1024,
          );
          if (content.sha !== blobSha || content.size !== size) throw imageFailure();
        } else if (size > 1024 * 1024) throw imageFailure();
        if (content.encoding !== "base64" || typeof content.content !== "string")
          throw imageFailure();
        const encoded = content.content.replace(/[\r\n]/g, "");
        if (
          encoded.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
          encoded.length > Math.ceil(IMAGE_BYTES_MAX / 3) * 4
        )
          throw imageFailure();
        const png = Buffer.from(encoded, "base64");
        if (
          png.length !== size ||
          png.toString("base64") !== encoded ||
          createHash("sha1").update(`blob ${size}\0`).update(png).digest("hex") !== blobSha
        )
          throw imageFailure();
        const hash = createHash("sha256").update(png).digest("hex");
        if (image.sha256 && image.sha256 !== hash) throw imageFailure();
        retain(png, known);
        const saved = { url: `/api/qa-report-assets/${hash}`, sha256: hash };
        fetched.set(image.url, saved);
        if (!retainedByHash.has(hash)) imageBytes += size;
        retainedByHash.set(hash, { ...image, ...saved });
        return { ...image, ...saved, sourceUrl: image.sourceUrl ?? image.url };
      };
      const portablePairs: QaVisualEvidence["pairs"] = [];
      for (const pair of input.visual?.pairs ?? []) {
        const saved = {
          ...pair,
          before: await archiveImage(pair.before),
          after: await archiveImage(pair.after),
          ...(pair.diff ? { diff: await archiveImage(pair.diff) } : {}),
        };
        if (
          !localPairs.some(
            (local) =>
              local.before.sha256 === saved.before.sha256 &&
              local.after.sha256 === saved.after.sha256 &&
              (!saved.diff || local.diff?.sha256 === saved.diff.sha256),
          )
        )
          portablePairs.push(saved);
      }
      const screenshots: NonNullable<QaVisualEvidence["screenshots"]> = [];
      for (const shot of input.visual?.screenshots ?? [])
        screenshots.push({ ...(await archiveImage(shot)), label: shot.label });
      const importVisual: QaVisualEvidence = retained.manifest
        ? {
            ...retained,
            applicability: "required",
            ...(input.visual?.reason ? { reason: input.visual.reason } : {}),
            pairs: [...localPairs, ...portablePairs],
            screenshots,
          }
        : retained.applicability === "required"
          ? { ...input.visual, applicability: "required", pairs: portablePairs, screenshots }
          : {
              ...(input.visual ?? { applicability: "unknown" }),
              pairs: portablePairs,
              screenshots,
            };
      const report = finish(
        {
          schemaVersion: 1,
          repoId: repo.id,
          github: repo.github,
          prNumber: input.prNumber,
          headSha: input.headSha,
          prTitle: pr.title,
          prUrl: `https://github.com/${repo.github}/pull/${input.prNumber}`,
          ...(typeof pr.head.ref === "string" ? { branch: pr.head.ref } : {}),
          source: "controller",
          reviewer: input.reviewer,
          reviewedAt: input.reviewedAt,
          registeredAt: at,
          sourceRef: input.sourceRef,
          verdict: input.verdict,
          summary: input.summary,
          worksWell: input.worksWell ?? [],
          coverage: input.coverage ?? [],
          findings: input.findings ?? [],
          resolutions: input.resolutions ?? [],
          tests: input.tests ?? [],
          ci,
          limitations: input.limitations ?? [],
          followUps: input.followUps ?? [],
          visual: importVisual,
        },
        { limitations: input.limitations !== undefined, followUps: input.followUps !== undefined },
        known,
      );
      return { report, created: i.store.putQaReport(report) };
    },
  };
}

export function qaReportMarkdown(report: QaReport): string {
  const lines = [
    `# QA report: ${report.github} PR #${report.prNumber}`,
    "",
    `Head: ${report.headSha}`,
    `Report: ${report.id}`,
    `Reviewer: ${report.reviewer.label} (${report.reviewer.id})${report.reviewer.model ? `, ${report.reviewer.model}` : ""}`,
    `Source: ${report.source}${report.sourceRef ? ` — ${report.sourceRef}` : ""}`,
    `Reviewed: ${report.reviewedAt === null ? "unknown" : new Date(report.reviewedAt).toISOString()}`,
    `Registered: ${new Date(report.registeredAt).toISOString()}`,
    `Recorded verdict: spec ${report.verdict.spec}; quality ${report.verdict.quality}.`,
    `Evidence: ${report.completeness.state}. This immutable snapshot is not live merge approval.`,
    "",
    report.summary,
    "",
    "## Works well",
    ...report.worksWell.map((text) => `- ${text}`),
    "",
    "## Checklist coverage",
    ...report.coverage.map(
      (check) => `- ${check.check}: ${check.result}${check.note ? ` — ${check.note}` : ""}`,
    ),
    "",
    "## Tests and receipts",
    ...report.tests.map(
      (test) =>
        `- ${test.command}: ${test.outcome}; source ${test.origin}; exit ${test.exitCode ?? "unknown"}; counts ${test.passed ?? "unknown"}/${test.failed ?? "unknown"}/${test.skipped ?? "unknown"} passed/failed/skipped.${test.evidence ? ` Receipt: ${test.evidence}` : ""}`,
    ),
    "",
    `## CI observed ${new Date(report.ci.observedAt).toISOString()} (${report.ci.source})`,
    ...report.ci.checks.map(
      (check) =>
        `- ${check.name}: ${check.state} (${check.conclusion})${check.url ? ` — ${check.url}` : ""}`,
    ),
    ...(report.ci.limitation ? [report.ci.limitation] : []),
    "",
    "## Findings",
    ...report.findings.map(
      (finding) =>
        `- ${finding.severity}, ${finding.file}:${finding.line}: ${finding.summary}\n  Scenario: ${finding.scenario}\n  Fix: ${finding.fix}`,
    ),
    "",
    "## Resolutions",
    ...report.resolutions.map(
      (r) => `- Review ${r.findingRef.reviewId}, finding ${r.findingRef.pos}: ${r.outcome}`,
    ),
    "",
    "## Limitations",
    ...report.limitations.map((text) => `- ${text}`),
    "",
    "## Follow-ups",
    ...report.followUps.map(
      (item) =>
        `- ${item.disposition}: ${item.text}${item.ticket ? ` — ${item.ticket}` : ""}${item.basis ? ` (${item.basis})` : ""}`,
    ),
    "",
    "## Visual evidence",
    `Applicability: ${report.visual.applicability}${report.visual.reason ? ` — ${report.visual.reason}` : ""}`,
    ...report.visual.pairs.map(
      (pair) =>
        `- ${pair.label}: [before](${pair.before.url}), [after](${pair.after.url})${pair.diff ? `, [diff](${pair.diff.url})` : ""}. ${pair.after.provenance ?? pair.after.source}`,
    ),
    "",
    "## Missing evidence",
    ...report.completeness.missing.map((text) => `- ${text}`),
    "",
    `Report permalink: ${report.permalink}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** Kept inside the existing review-comment/PR-body write; the full export remains immutable. */
export function qaReportGitSummary(report: QaReport, baseUrl = ""): string {
  const short = (text: string, limit = 800) => Array.from(text).slice(0, limit).join("");
  const lines = [
    "## Saved QA report",
    "",
    `[Immutable QA report](${baseUrl}${report.permalink}) · [Markdown export](${baseUrl}/api/qa-reports/${report.id}/markdown)`,
    `Head ${report.headSha}; reviewer ${report.reviewer.label}; source ${report.source}; registered ${new Date(report.registeredAt).toISOString()}; evidence ${report.completeness.state}.`,
    "This snapshot is not current merge approval.",
    "",
    "Works well:",
    ...(report.worksWell.length
      ? report.worksWell.slice(0, 8).map((text) => `- ${short(text)}`)
      : ["- Not recorded."]),
    "",
    "Checklist:",
    ...report.coverage.map(
      (check) =>
        `- ${check.check}: ${check.result}${check.note ? ` — ${short(check.note, 300)}` : ""}`,
    ),
    "",
    "Limitations:",
    ...(report.limitations.length
      ? report.limitations.slice(0, 8).map((text) => `- ${short(text)}`)
      : ["- See the report's completeness and missing-evidence fields."]),
    "",
    "Follow-up disposition:",
    ...(report.followUps.length
      ? report.followUps
          .slice(0, 8)
          .map(
            (item) =>
              `- ${item.disposition}: ${short(item.text)}${item.ticket ? ` — ${item.ticket}` : ""}${item.basis ? ` (${short(item.basis, 300)})` : ""}`,
          )
      : ["- No follow-ups listed; see completeness for any unrecorded section."]),
    "",
    `Visual applicability: ${report.visual.applicability}${report.visual.reason ? ` — ${short(report.visual.reason, 1000)}` : ""}.`,
    `${report.visual.pairs.length} retained/reference before-and-after pairs. Test commands and their hub/controller/reviewer provenance are in the immutable report; reported counts are not execution receipts.`,
  ];
  const body = lines.join("\n");
  return body.length <= 12000
    ? body
    : `${short(body, 11900)}\n[Summary shortened; read the immutable report.]`;
}
