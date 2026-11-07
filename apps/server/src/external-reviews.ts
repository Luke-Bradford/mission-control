/** Reviews for same-repository PRs with no unfinished crew run. No build run is invented. */
import {
  type EvidenceManifest,
  evidenceSectionText,
  isReviewBudgetFailure,
  type PullRequestView,
  REVIEW_STATUS_CONTEXT,
  type ReviewRow,
  type Run,
  type TicketView,
} from "@mc/core";
import type { CcConfig } from "./config.ts";
import { externalReviewAsked } from "./external-pr-control.ts";
import { externalReviewKey, isExternalReview } from "./external-review-key.ts";
import type { GhRunner } from "./mcp/gh.ts";
import { ownsPr } from "./ownership.ts";
import type { PrEvidence } from "./pr-evidence/capture.ts";
import { postPrEvidence } from "./pr-evidence/sweep.ts";
import { qaReportGitSummary } from "./qa-reports.ts";
import type { Store } from "./store.ts";

export { externalReviewKey, isExternalReview } from "./external-review-key.ts";

/**
 * A branch the crew or an observed loop still owns: a build run that has not ended, any run of a
 * configured loop (observed loops are read-only, so their PRs never take the external path), a
 * seat that has claimed the branch's handoff and has no run row yet, or, given the PR's ticket, a
 * live run on that ticket under another branch.
 */
export const branchOwned = (
  config: Pick<CcConfig, "loops">,
  store: Store,
  repoId: string,
  branch: string,
  ticket?: string | null,
): boolean => {
  const live = (run: Run) =>
    run.reviewId == null &&
    (run.endedAt === null || config.loops.some((loop) => loop.id === run.agentId));
  return (
    store.runsOnBranch(repoId, branch).some(live) ||
    (ticket != null &&
      store
        .runsOnTicket(repoId, ticket)
        .some((run) => run.endedAt === null && run.reviewId == null)) ||
    store
      .claimedHandoffs(repoId)
      .some((h) => h.branch === branch || (ticket != null && h.ticket === ticket))
  );
};

export interface ExternalReviewSubject {
  sha: string;
  branch: string;
  ticket: TicketView;
}

/** Fresh provenance is required before executing any code or publishing a verdict. */
export async function readExternalSubject(
  gh: GhRunner,
  cwd: string,
  repo: CcConfig["repos"][number],
  number: number,
  sha: string,
): Promise<ExternalReviewSubject | null> {
  if (!Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40}$/.test(sha)) return null;
  const result = await gh(["api", `repos/${repo.github}/pulls/${number}`], { cwd });
  if (result.code !== 0) throw new Error("external review PR could not be read");
  const value: unknown = JSON.parse(result.stdout);
  if (value === null || typeof value !== "object") return null;
  const pr = value as {
    number?: unknown;
    state?: unknown;
    draft?: unknown;
    title?: unknown;
    body?: unknown;
    html_url?: unknown;
    labels?: { name?: unknown }[];
    head?: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } };
    base?: { ref?: unknown; repo?: { full_name?: unknown; default_branch?: unknown } };
  };
  const sameRepo = (name: unknown) =>
    typeof name === "string" && name.toLowerCase() === repo.github.toLowerCase();
  if (
    pr.number !== number ||
    pr.state !== "open" ||
    pr.draft !== false ||
    pr.head?.sha !== sha ||
    !sameRepo(pr.head.repo?.full_name) ||
    !sameRepo(pr.base?.repo?.full_name) ||
    typeof pr.head.ref !== "string" ||
    typeof pr.base?.repo?.default_branch !== "string" ||
    pr.base.ref !== pr.base.repo.default_branch ||
    typeof pr.title !== "string" ||
    (pr.body !== null && typeof pr.body !== "string") ||
    !Array.isArray(pr.labels) ||
    pr.labels.length > 100 ||
    pr.labels.some((label) => typeof label?.name !== "string") ||
    pr.labels.some((label) => label.name === "skip-review")
  )
    return null;
  const body = pr.body ?? "";
  return {
    sha,
    branch: pr.head.ref,
    ticket: {
      number,
      title: pr.title.slice(0, 500),
      url: `https://github.com/${repo.github}/pull/${number}`,
      state: "open",
      body: Array.from(body).slice(0, 20_000).join(""),
      bodyTruncated: Array.from(body).length > 20_000,
      bodyLength: Array.from(body).length,
      labels: pr.labels.map((label) => label.name as string),
      milestone: null,
      subIssues: [],
      pullRequests: [],
    },
  };
}

export interface ExternalReviews {
  sync(): Promise<void>;
  wanted(row: ReviewRow): boolean;
}

export function createExternalReviews(deps: {
  config: CcConfig;
  store: Store;
  gh: GhRunner;
  cwd: string;
  reviewer(
    repoId: string,
    pick?: { author?: string | undefined; role?: string | undefined; avoid?: ReadonlySet<string> },
  ): string | null;
  evidence?: PrEvidence;
  reportBaseUrl?: string;
  evidenceManifest?(repo: string, pr: number, sha: string): EvidenceManifest | null;
  /** Refuses secrets/mentions before any new GitHub comment; failures stay private. */
  textAllowed(text: string, repo: string, pr: number): Promise<boolean>;
  now(): number;
  log(text: string): void;
  enabled?(): boolean;
}): ExternalReviews {
  const { store } = deps;
  let syncing = false;
  /** A review is this hub's work: its branch has a run here, or someone asked it to review this head. */
  const mine = (repoId: string, pr: Pick<PullRequestView, "number" | "branch" | "headSha">) =>
    ownsPr(store, repoId, pr) ||
    (pr.headSha != null && externalReviewAsked(store, repoId, pr.number, pr.headSha, true));
  /**
   * A review that reported on a head after its author run ended (or went away) has no crew loop
   * left to post it, so this hub posts it as it does an external one.
   */
  const orphaned = (row: ReviewRow) => {
    if (isExternalReview(row) || row.state !== "reported") return false;
    const author = store.run(row.authorRunId);
    return author === null || author.endedAt !== null;
  };
  /** Why this row is not posted now, or null when it is. */
  function notWanted(row: ReviewRow): string | null {
    const repo = deps.config.repos.find((r) => r.id === row.repoId);
    const pr = store.pullRequests(row.repoId).find((p) => p.number === row.prNumber);
    if (!isExternalReview(row) && !orphaned(row)) return "a crew run still owns the review";
    if (!(deps.enabled?.() ?? true)) return "the engine is off";
    if (repo?.autonomy !== "merge") return "the repo is not on merge autonomy";
    if (pr?.state !== "open") return "the PR is not open";
    if (pr.isDraft) return "the PR is a draft";
    if (pr.headSha !== row.sha) return "the PR head has moved";
    if (branchOwned(deps.config, store, row.repoId, pr.branch, pr.ticket))
      return "a crew run or claim still owns the branch";
    if (!mine(row.repoId, pr)) return "this hub neither ran the branch nor was asked to review it";
    return null;
  }
  const wanted = (row: ReviewRow): boolean => notWanted(row) === null;
  /** One line per row and reason: a final result left unposted on purpose says so, once. */
  const said = new Set<string>();
  function skipped(pr: PullRequestView, row: ReviewRow, why: string): void {
    if (row.state !== "reported" && row.state !== "failed") return;
    const key = `${row.id}:${why}`;
    if (said.has(key)) return;
    said.add(key);
    deps.log(`External QA for ${row.repoId}#${pr.number} is not posted to GitHub: ${why}.`);
  }

  async function publish(pr: PullRequestView, row: ReviewRow): Promise<void> {
    if (row.state === "superseded") return;
    const why = notWanted(row);
    if (why !== null) return skipped(pr, row, why);
    const repo = deps.config.repos.find((r) => r.id === row.repoId);
    if (!repo) return;
    const state =
      row.state === "reported"
        ? row.blocking === 0 && row.verdict?.spec === "pass" && row.verdict.quality === "pass"
          ? "success"
          : "failure"
        : row.state === "failed"
          ? "failure"
          : "pending";
    const description =
      row.state === "reported"
        ? state === "success"
          ? "QA review passed"
          : "QA review found blocking issues"
        : row.state === "failed"
          ? "QA review did not complete"
          : row.state === "queued"
            ? "QA review queued"
            : "QA review running";
    const statusKey = `external-review-status:${row.id}`;
    const fingerprint = `${state}:${description}`;
    const commentKey = `external-review-comment:${row.id}`;
    const needsComment = row.state === "reported" && store.getSetting(commentKey) === null;
    if (store.getSetting(statusKey) === fingerprint && !needsComment) return;
    if (!(await readExternalSubject(deps.gh, deps.cwd, repo, row.prNumber, row.sha))) return;
    // A crew run may have claimed the branch during the read.
    if (!wanted(row)) return;
    if (needsComment) {
      const marker = `<!-- mission-control-review:${row.id}:${row.sha} -->`;
      const findings = store.findingsOf(row.id);
      const report = store.qaReportForReview(row.id);
      const manifest = deps.evidenceManifest?.(row.repoId, row.prNumber, row.sha);
      const body = [
        marker,
        `## QA review — ${row.sha}`,
        `Reviewer: ${row.seatId}. Round ${row.round}. ${row.blocking} blocking, ${row.minor} minor findings.`,
        row.summary ?? "No summary was recorded.",
        ...(report
          ? [qaReportGitSummary(report, deps.reportBaseUrl ?? deps.evidence?.baseUrl ?? "")]
          : []),
        ...findings.map(
          (finding) =>
            `- **${finding.severity}** ${finding.file}:${finding.line} — ${finding.summary}\n  ${finding.scenario}\n  Suggested fix: ${finding.fix}`,
        ),
        "### Recorded checks",
        ...store.reviewChecks(row.id).map((check) => `- ${check.check}: ${check.result}`),
        "### Reviewer-reported test counts",
        ...store
          .reviewTests(row.id)
          .map(
            (test) =>
              `- ${test.command}: ${test.passed} passed, ${test.failed} failed, ${test.skipped} skipped`,
          ),
        manifest && deps.evidence
          ? evidenceSectionText(manifest, deps.evidence.baseUrl)
          : "No before/after screenshot pairs were captured for this review head.",
        "This verdict records a scratch review. It does not waive CI, acceptance or repository merge rules.",
      ].join("\n\n");
      if (body.length > 60_000 || !(await deps.textAllowed(body, repo.github, pr.number)))
        throw new Error("external review comment was withheld by the text check");
      const endpoint = `repos/${repo.github}/issues/${pr.number}/comments`;
      const existing = await deps.gh(["api", `${endpoint}?per_page=100`, "--paginate", "--slurp"], {
        cwd: deps.cwd,
      });
      if (existing.code !== 0) throw new Error("external review comments could not be checked");
      const pages: unknown = JSON.parse(existing.stdout);
      if (!Array.isArray(pages) || !pages.every(Array.isArray))
        throw new Error("external review comments were unreadable");
      const comments: unknown[] = pages.flat();
      if (
        !comments.some(
          (comment) =>
            comment !== null &&
            typeof comment === "object" &&
            "body" in comment &&
            typeof comment.body === "string" &&
            comment.body.includes(marker),
        )
      ) {
        if (
          !(await readExternalSubject(deps.gh, deps.cwd, repo, row.prNumber, row.sha)) ||
          !wanted(row)
        )
          return;
        const posted = await deps.gh(["api", "--method", "POST", endpoint, "--input", "-"], {
          cwd: deps.cwd,
          input: JSON.stringify({ body }),
        });
        if (posted.code !== 0) throw new Error("external review comment could not be posted");
      }
      store.setSetting(commentKey, "posted");
    }
    if (store.getSetting(statusKey) !== fingerprint) {
      if (
        !(await readExternalSubject(deps.gh, deps.cwd, repo, row.prNumber, row.sha)) ||
        !wanted(row)
      )
        return;
      const posted = await deps.gh(
        ["api", "--method", "POST", `repos/${repo.github}/statuses/${row.sha}`, "--input", "-"],
        {
          cwd: deps.cwd,
          input: JSON.stringify({
            state,
            description,
            context: REVIEW_STATUS_CONTEXT,
            target_url: pr.url,
          }),
        },
      );
      if (posted.code !== 0) throw new Error("external review status could not be posted");
      store.setSetting(statusKey, fingerprint);
    }
  }

  return {
    wanted,
    async sync() {
      if (syncing || !(deps.enabled?.() ?? true)) return;
      syncing = true;
      try {
        for (const repo of deps.config.repos) {
          if (repo.autonomy !== "merge") continue;
          for (const pr of store.pullRequests(repo.id)) {
            if (pr.state !== "open" || !pr.headSha) continue;
            // a result this hub holds for the head that these filters leave unposted says why
            const holds = (why: string) => {
              const held = store
                .reviewsOfPr(repo.id, pr.number)
                .findLast(
                  (r) =>
                    r.sha === pr.headSha &&
                    r.state === "reported" &&
                    (isExternalReview(r) || orphaned(r)),
                );
              if (held) skipped(pr, held, why);
            };
            if (pr.isDraft) {
              holds("the PR is a draft");
              continue;
            }
            if (branchOwned(deps.config, store, repo.id, pr.branch, pr.ticket)) {
              holds("a crew run or claim still owns the branch");
              continue;
            }
            // a review is this hub's work: a run here made the branch, or someone asked for this head
            if (!mine(repo.id, pr)) {
              holds("this hub neither ran the branch nor was asked to review it");
              continue;
            }
            try {
              const identity = externalReviewKey(repo.id, pr.number);
              const reviews = store.reviewsOfRun(identity);
              let row = reviews.findLast(
                (review) => review.sha === pr.headSha && review.state !== "superseded",
              );
              // a review that ran out of tokens is tried again on another review seat, if there is one
              const failedSeats = new Set(
                reviews
                  .filter(
                    (review) =>
                      review.sha === pr.headSha &&
                      review.state === "failed" &&
                      isReviewBudgetFailure(review.failure),
                  )
                  .map((review) => review.seatId),
              );
              const retry = row?.state === "failed" && failedSeats.has(row.seatId);
              if (row === undefined) {
                // a crew review of this head reported after its author's run ended: post it, and
                // do not review the head again
                const crew = store
                  .reviewsOfPr(repo.id, pr.number)
                  .findLast((r) => r.sha === pr.headSha && orphaned(r));
                if (crew) {
                  await publish(pr, crew);
                  continue;
                }
              }
              if ((row === undefined || retry) && pr.ci === "passing") {
                if (
                  reviews.length === 0 &&
                  pr.checks?.some((check) => check.name === REVIEW_STATUS_CONTEXT) &&
                  // the status is another reviewer's only when this hub has no review of this head,
                  // and the branch has no crew run (its own mc/review may be waived or carried)
                  !store.reviewsOfPr(repo.id, pr.number).some((r) => r.sha === pr.headSha) &&
                  !store.runsOnBranch(repo.id, pr.branch).some((run) => run.reviewId == null)
                )
                  continue;
                // the ended author's seat is the one the reviewer must avoid, as on a crew review
                const author = store
                  .runsOnBranch(repo.id, pr.branch)
                  .filter((run) => run.reviewId == null)
                  .sort((a, b) => (a.endedAt ?? Infinity) - (b.endedAt ?? Infinity))
                  .at(-1);
                const seat = deps.reviewer(repo.id, {
                  author: author?.agentId,
                  role: author?.profile?.profile.reviewer.role,
                  avoid: failedSeats,
                });
                if (retry && seat && failedSeats.has(seat)) {
                  // no other review seat: the failed review stands
                  if (row) await publish(pr, row);
                  continue;
                }
                if (
                  !seat ||
                  !(await readExternalSubject(deps.gh, deps.cwd, repo, pr.number, pr.headSha))
                )
                  continue;
                if (deps.evidence) {
                  const recorded = store.prFilePaths(repo.id, pr.number);
                  const paths =
                    pr.changedFiles != null && recorded.length === pr.changedFiles
                      ? recorded
                      : ["apps/web/src/hud.css"];
                  const target = {
                    repoId: repo.id,
                    pr: pr.number,
                    sha: pr.headSha,
                    paths,
                    onStored: (manifest: Parameters<typeof postPrEvidence>[3]) =>
                      postPrEvidence(
                        deps.gh,
                        deps.cwd,
                        repo.github,
                        manifest,
                        deps.evidence!.baseUrl,
                      ),
                  };
                  void deps.evidence
                    .ensure(target)
                    .catch(() =>
                      deps.log(
                        `External QA for ${repo.id}#${pr.number} could not prepare screenshots.`,
                      ),
                    );
                  if (deps.evidence.gate(target) !== null) continue;
                }
                if (
                  !(deps.enabled?.() ?? true) ||
                  store.pullRequests(repo.id).find((p) => p.number === pr.number)?.headSha !==
                    pr.headSha
                )
                  continue;
                const id = store.requestReview({
                  authorRunId: identity,
                  repoId: repo.id,
                  seatId: seat,
                  prNumber: pr.number,
                  sha: pr.headSha,
                  epoch: 0,
                  attempt: reviews.filter((review) => review.sha === pr.headSha).length + 1,
                  // every review of the PR counts, the crew's own on older heads too
                  round:
                    store
                      .reviewsOfPr(repo.id, pr.number)
                      .filter((review) => review.state === "reported").length + 1,
                  at: deps.now(),
                });
                row = id === null ? undefined : (store.review(id) ?? undefined);
              }
              if (row) await publish(pr, row);
            } catch {
              // PR text, credentials and command output never enter this log.
              deps.log(
                `External QA for ${repo.id}#${pr.number} could not complete its queue/status update; it will retry.`,
              );
            }
          }
        }
      } finally {
        syncing = false;
      }
    },
  };
}
