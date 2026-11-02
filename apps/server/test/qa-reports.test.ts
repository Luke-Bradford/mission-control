import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EvidenceManifest, QaReportImport } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import type { GhRunner } from "../src/mcp/gh.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import { prEvidenceStore } from "../src/pr-evidence/store.ts";
import { createQaReports, qaReportMarkdown } from "../src/qa-reports.ts";
import { Store } from "../src/store.ts";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const NOW = 1_800_000_000_000;
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  repos: [{ id: "sample", github: "example/sample", project: 1, statusMap: {}, autonomy: "merge" }],
  loops: [],
  poll: { usageMinutes: 5, githubSeconds: 60 },
};
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVEsAAAAASUVORK5CYII=",
  "base64",
);
let dir: string;
let path: string;
let store: Store;
let head: string;
let known: string[];
let scanFails: boolean;
let ciFails: boolean;
let calls: string[][];
const gh: GhRunner = async (args) => {
  calls.push(args);
  if (args[0] === "api")
    return {
      code: 0,
      stdout: JSON.stringify({
        number: 7,
        state: "closed",
        merged: true,
        title: "Sample change",
        head: { sha: head, ref: "controller/change" },
        base: { repo: { full_name: "example/sample" } },
      }),
      stderr: "",
    };
  return {
    code: ciFails ? 1 : 0,
    stdout: JSON.stringify({
      headRefOid: head,
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          name: "check",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          detailsUrl: "https://github.com/example/sample/actions/runs/1",
        },
      ],
    }),
    stderr: "",
  };
};
const service = () =>
  createQaReports({
    store,
    config,
    gh,
    cwd: dir,
    assetsDir: join(dir, "assets"),
    evidence: prEvidenceStore(join(dir, "evidence")),
    knownSecrets: async () => {
      if (scanFails) throw new Error("fixture unavailable");
      return known;
    },
    now: () => NOW,
  });
const input = (over: Partial<QaReportImport> = {}): QaReportImport => ({
  repoId: "sample",
  prNumber: 7,
  headSha: SHA,
  reviewer: { id: "controller-reviewer", label: "Independent reviewer", model: "fixture-model" },
  reviewedAt: NOW - 1000,
  sourceRef: "https://github.com/example/sample/pull/7#issuecomment-1",
  verdict: { spec: "pass", quality: "pass" },
  summary: "Checked the changed behavior.",
  worksWell: ["The changed API preserves exact-head provenance."],
  coverage: [{ check: "authorization", result: "pass", note: "In-process boundary cases." }],
  findings: [],
  resolutions: [],
  tests: [
    {
      command: "pnpm test:related",
      origin: "controller-recorded",
      outcome: "passed",
      exitCode: 0,
      at: NOW - 2000,
      evidence: "Retained fixture receipt: command completed, exit 0; one boundary case passed.",
      passed: 1,
      failed: 0,
      skipped: 0,
    },
  ],
  limitations: [],
  followUps: [],
  visual: {
    applicability: "not_applicable",
    reason: "Server-only change; no screen changes.",
    pairs: [],
  },
  ...over,
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-qa-report-"));
  path = join(dir, "mc.sqlite");
  store = new Store(path);
  head = SHA;
  known = [];
  scanFails = false;
  ciFails = false;
  calls = [];
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("durable QA report archive", () => {
  it("imports a merged PR without inventing a Run/review and retains exact source/time/CI", async () => {
    const reports = service();
    const { report, created } = await reports.importController(input());
    expect(created).toBe(true);
    expect(report).toMatchObject({
      source: "controller",
      reviewedAt: NOW - 1000,
      registeredAt: NOW,
      headSha: SHA,
      ci: { source: "github", observedAt: NOW, headSha: SHA },
      completeness: { state: "complete", missing: [] },
    });
    expect(report.id).toMatch(/^[a-f0-9]{64}$/);
    expect(report.permalink).toContain(`report=${report.id}`);
    expect(store.reviewsIn(["queued", "running", "reported"])).toEqual([]);
    expect(store.loopRuns(NOW)).toEqual([]);
    expect(calls.every((args) => !args.includes("POST") && !args.includes("PATCH"))).toBe(true);
    expect((await reports.importController(input())).created).toBe(false);
    expect(store.putQaReport({ ...report, summary: "Overwrite attempt" })).toBe(false);
    expect(reports.read(report.id)?.summary).toBe("Checked the changed behavior.");
    store.close();
    store = new Store(path);
    expect(service().read(report.id)).toEqual(report);
    expect(service().list("sample", 7, BASE)).toEqual([]);
    expect(service().list("sample", 7)).toHaveLength(1);
  });

  it("keeps unknown historical time and missing sections incomplete rather than inventing approval", async () => {
    const { report } = await service().importController(
      input({
        reviewedAt: null,
        worksWell: undefined,
        tests: undefined,
        coverage: undefined,
        limitations: undefined,
        followUps: undefined,
        visual: undefined,
      }),
    );
    expect(report.reviewedAt).toBeNull();
    expect(report.completeness.state).toBe("incomplete");
    expect(report.completeness.missing.join(" ")).toMatch(/time is unknown/);
    expect(qaReportMarkdown(report)).toContain("not live merge approval");
  });

  it("does not turn reported test counts or arbitrary reviewer evidence into execution receipts", async () => {
    const { report } = await service().importController(
      input({
        tests: [
          {
            command: "pnpm test",
            origin: "reviewer-reported",
            outcome: "passed",
            passed: 999,
            evidence: "Counts only, as stated by the author.",
          },
        ],
      }),
    );
    expect(report.tests[0]?.origin).toBe("reviewer-reported");
    expect(report.completeness.missing.join(" ")).toContain("execution receipts");
    expect(qaReportMarkdown(report)).toContain("source reviewer-reported");
  });

  it.each(["head", "source", "native-proof", "secret", "scan"])(
    "fails closed for invalid provenance or sensitive data: %s",
    async (failure) => {
      let body = input();
      if (failure === "head") head = BASE;
      if (failure === "source")
        body.sourceRef = "https://github.com/example/sample/pull/70#issuecomment-1";
      if (failure === "native-proof")
        body = {
          ...body,
          tests: [{ command: "pnpm test", origin: "hub-receipt", outcome: "passed" }],
        } as unknown as QaReportImport;
      if (failure === "secret") {
        known = ['private"credential-value'];
        body.summary = `Do not save ${known[0]}.`;
      }
      if (failure === "scan") scanFails = true;
      await expect(service().importController(body)).rejects.toThrow();
      expect(store.qaReports("sample", 7)).toEqual([]);
    },
  );

  it("records unavailable fresh CI honestly without attributing cached green to the head", async () => {
    ciFails = true;
    const { report } = await service().importController(input());
    expect(report.ci).toMatchObject({ source: "unavailable", checks: [], headSha: SHA });
    expect(report.completeness.missing.join(" ")).toContain("CI gate receipts");
  });

  it("retains same-head controlled-fixture manifest/images for a controller report beyond native sweep", async () => {
    const evidence = prEvidenceStore(join(dir, "evidence"));
    const manifest = {
      repoId: "sample",
      pr: 7,
      sha: SHA,
      mainSha: BASE,
      capturedAt: NOW - 100,
      pairs: [{ page: "audit", scheme: "light", changedPixels: 1, changedPercent: 1, regions: [] }],
      provenance: {
        kind: "reconstructed-controlled-fixture",
        detail: "Re-rendered after merge; not original approval or live data.",
      },
    } as EvidenceManifest;
    evidence.save(
      manifest,
      ["before", "after", "diff"].map((kind) => ({ name: `audit-light-${kind}.png`, png: PNG })),
    );
    const reports = service();
    const hash = createHash("sha256").update(PNG).digest("hex");
    const reference = (kind: string) => ({
      url: `https://raw.githubusercontent.com/example/sample/${BASE}/docs/${kind}.png`,
      source: "controlled-fixture" as const,
      sha256: hash,
      provenance: "Controlled source fixture, rendered after merge.",
    });
    const { report } = await reports.importController(
      input({
        reviewedAt: null,
        visual: {
          applicability: "required",
          reason: "Controlled fixture rendered after merge.",
          pairs: [
            { label: "Portable fixture", before: reference("before"), after: reference("after") },
          ],
        },
      }),
    );
    expect(report.source).toBe("controller");
    expect(report.nativeReviewId).toBeUndefined();
    expect(report.visual.pairs).toHaveLength(1);
    expect(report.visual.pairs[0]?.label).toBe("audit, light");
    expect(report.visual.pairs[0]?.before.sourceUrl).toBe(reference("before").url);
    expect(report.visual.pairs[0]?.after.sourceUrl).toBe(reference("after").url);
    expect(report.visual.pairs[0]?.after.source).toBe("controlled-fixture");
    const image = report.visual.pairs[0]?.after;
    if (!image?.sha256) throw new Error("retained image missing");
    expect(statSync(join(dir, "assets")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "assets", `${image.sha256}.png`)).mode & 0o777).toBe(0o600);
    for (const digit of ["c", "d", "e"])
      evidence.save(
        { ...manifest, sha: digit.repeat(40), capturedAt: NOW + digit.charCodeAt(0) },
        [],
      );
    expect(evidence.manifest("sample", 7, SHA)).toBeNull();
    expect(reports.asset(image.sha256)).toEqual(PNG);
    store.close();
    store = new Store(path);
    expect(service().read(report.id)?.visual.manifest).toEqual(manifest);
    expect(service().asset(image.sha256)).toEqual(PNG);
    const app = buildApp({
      config,
      store,
      bus: new ChangeBus(),
      operatorToken: "fixture-key",
      qaReports: service(),
    });
    try {
      expect((await app.inject(image.url)).statusCode).toBe(401);
      const png = await app.inject({ url: image.url, headers: { "x-mc-operator": "fixture-key" } });
      expect(png.statusCode).toBe(200);
      expect(png.headers["cache-control"]).toBe("private, no-store");
      expect(png.rawPayload).toEqual(PNG);
    } finally {
      await app.close();
    }
  });

  it("keeps a native snapshot atomically with findings and independent of native row deletion", async () => {
    const id = store.requestReview({
      authorRunId: "author",
      repoId: "sample",
      seatId: "retro",
      prNumber: 7,
      sha: SHA,
      epoch: 0,
      attempt: 1,
      round: 1,
      at: NOW - 100,
    });
    if (!id) throw new Error("review missing");
    store.setReviewState(id, ["queued"], "running", { at: NOW - 50, runId: "retro:review" });
    store.addCheckRun({
      runId: "retro:review",
      command: "pnpm test:related",
      headSha: SHA,
      ok: true,
      exitCode: 0,
      at: NOW - 10,
    });
    store.addCheckRun({
      runId: "retro:review",
      command: "other-head",
      headSha: BASE,
      ok: true,
      at: NOW - 10,
    });
    const details = {
      verdict: { spec: "pass", quality: "pass" } as const,
      summary: "Native review complete.",
      findings: [],
      worksWell: ["The API boundary cases hold."],
      limitations: [],
      followUps: [],
      tests: [
        { command: "author-reported-counts", passed: 200, failed: 0, skipped: 0, duration: 20 },
      ],
    };
    const row = store.review(id);
    if (!row) throw new Error("review missing");
    const report = await service().prepareNative(row, details, NOW);
    expect(report.ci.source).toBe("github");
    expect(report.tests.map((test) => test.command)).toEqual([
      "pnpm test:related",
      "author-reported-counts",
    ]);
    expect(report.tests.map((test) => test.origin)).toEqual(["hub-receipt", "reviewer-reported"]);
    expect(store.recordFindings(id, "wrong-run", { ...details, at: NOW, qaReport: report })).toBe(
      false,
    );
    expect(store.qaReportForReview(id)).toBeNull();
    const fail = vi.spyOn(store, "putQaReport").mockImplementationOnce(() => {
      throw new Error("fixture disk failure");
    });
    expect(() =>
      store.recordFindings(id, "retro:review", { ...details, at: NOW, qaReport: report }),
    ).toThrow("fixture disk failure");
    fail.mockRestore();
    expect(store.review(id)?.state).toBe("running");
    expect(store.findingsOf(id)).toEqual([]);
    expect(store.qaReportForReview(id)).toBeNull();
    expect(
      store.recordFindings(id, "retro:review", { ...details, at: NOW, qaReport: report }),
    ).toBe(true);
    expect(store.qaReportForReview(id)).toEqual(report);
    store.close();
    const db = new DatabaseSync(path);
    db.exec("DELETE FROM review_findings; DELETE FROM reviews;");
    db.close();
    store = new Store(path);
    expect(service().read(report.id)).toEqual(report);
  });

  it("requires visual pairs for known native web changes despite a supplied N/A reason", async () => {
    const id = store.requestReview({
      authorRunId: "author",
      repoId: "sample",
      seatId: "retro",
      prNumber: 7,
      sha: SHA,
      epoch: 0,
      attempt: 1,
      round: 1,
      at: NOW,
    });
    if (!id) throw new Error("missing review");
    store.setReviewState(id, ["queued"], "running", { runId: "retro:review", at: NOW });
    const db = new DatabaseSync(path);
    db.prepare(
      "INSERT INTO pr_files (repo_id, pr_number, path, change_type) VALUES (?, ?, ?, 'modified')",
    ).run("sample", 7, "apps/web/src/pages/Overview.tsx");
    db.close();
    const row = store.review(id);
    if (!row) throw new Error("missing review");
    const report = await service().prepareNative(
      row,
      {
        verdict: { spec: "pass", quality: "pass" },
        summary: "Reported review.",
        findings: [],
        visualReason: "No screenshot needed.",
      },
      NOW,
    );
    expect(report.visual.applicability).toBe("required");
    expect(report.completeness.missing.join(" ")).toContain("Before/after");
  });
});

describe("QA report API", () => {
  it("requires operator authority, refuses seat/FLIGHT provenance, and serves configured archive reads/Markdown", async () => {
    const tokens = new RunTokens();
    const seat = tokens.issue("retro", "retro:review");
    const app = buildApp({
      config,
      store,
      bus: new ChangeBus(),
      operatorToken: "fixture-key",
      tokens,
      qaReports: service(),
      now: () => NOW,
    });
    try {
      const post = (headers: Record<string, string>) =>
        app.inject({ method: "POST", url: "/api/qa-reports/import", headers, payload: input() });
      expect((await post({})).statusCode).toBe(401);
      expect(
        (await post({ "x-mc-operator": "fixture-key", authorization: `Bearer ${seat}` }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await post({
            "x-mc-operator": "fixture-key",
            "x-mc-flight-actor": JSON.stringify({ seatId: "flight", runId: "flight:1" }),
          })
        ).statusCode,
      ).toBe(403);
      const saved = await post({ "x-mc-operator": "fixture-key" });
      expect(saved.statusCode).toBe(201);
      const report = saved.json().report;
      expect((await app.inject(`/api/qa-reports/${report.id}`)).json()).toEqual(report);
      const markdown = await app.inject(`/api/qa-reports/${report.id}/markdown`);
      expect(markdown.headers["content-type"]).toContain("text/markdown");
      expect(markdown.body).toContain(SHA);
      expect(
        (await app.inject("/api/qa-reports?repoId=sample&prNumber=7")).json().reports,
      ).toHaveLength(1);
      expect(
        (await app.inject(`/api/qa-reports?repoId=sample&prNumber=7&headSha=${BASE}`)).json()
          .reports,
      ).toEqual([]);
      expect(
        (await app.inject("/api/qa-reports?repoId=sample&prNumber=7&headSha=short")).statusCode,
      ).toBe(400);
      expect((await app.inject("/api/qa-report-assets/../../secret")).statusCode).toBe(404);
      config.repos[0]!.id = "removed";
      expect((await app.inject(`/api/qa-reports/${report.id}`)).statusCode).toBe(404);
      config.repos[0]!.id = "sample";
    } finally {
      await app.close();
    }
  });
});
