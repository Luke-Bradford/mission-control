import { randomUUID } from "node:crypto";
import {
  CODE_HEALTH_EVIDENCE_PAGE_MAX,
  type CodeHealthCoverage,
  type CodeHealthEvidenceRef,
  type CodeHealthTab,
  type CodeHealthView,
  type CodeHealthWindow,
  codeHealthFindingCategories,
  codeHealthReviewRounds,
  codeHealthWindowBounds,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import type { Store } from "../store.ts";

const CACHE_MS = 60_000;
const CACHE_MAX = 200;
const EVIDENCE_MAX = 2000;
type EvidenceKind = "review-rounds" | "findings" | "sizes" | "ci" | "durations";
interface EvidenceQuery {
  repoId: string;
  kind: EvidenceKind;
  from: number;
  until: number;
  revision: string;
  reference: CodeHealthEvidenceRef;
  sha?: string;
  file?: string;
}

export { CodeHealthReadError } from "./error.ts";

import { CodeHealthReadError } from "./error.ts";

/** One bounded calculation shared by the HUD and the later read-only tool handler. */
export class CodeHealthReader {
  private readonly store: Store;
  private readonly config: CcConfig;
  private readonly now: () => number;
  private readonly cache = new Map<
    string,
    { revision: string; expires: number; value: CodeHealthView }
  >();
  private readonly recommendationRefresh = new Map<string, { revision: string; at: number }>();
  private readonly evidenceQueries = new Map<string, EvidenceQuery>();

  constructor(store: Store, config: CcConfig, now: () => number = Date.now) {
    this.store = store;
    this.config = config;
    this.now = now;
  }

  private repo(repoId: string) {
    const repo = this.config.repos.find((row) => row.id === repoId);
    if (!repo) throw new CodeHealthReadError(404, "Unknown code-health repo");
    return repo;
  }

  private checkout(repoId: string): string | undefined {
    return this.config.crew?.sessions.find((row) => row.repoId === repoId)?.checkout;
  }

  private reference(
    query: Omit<EvidenceQuery, "reference">,
    label: string,
    definition: string,
    coverage: CodeHealthCoverage,
  ): CodeHealthEvidenceRef {
    const reference = {
      id: `ch_${randomUUID()}`,
      repoId: query.repoId,
      label,
      definition,
      coverage,
    };
    if (this.evidenceQueries.size >= EVIDENCE_MAX) {
      const oldest = this.evidenceQueries.keys().next().value;
      if (oldest) this.evidenceQueries.delete(oldest);
      // Cached summaries can hold this reference inside a file row as well as at the top level.
      // A refresh must build new references after eviction.
      this.cache.clear();
    }
    this.evidenceQueries.set(reference.id, { ...query, reference });
    return reference;
  }

  read(repoId: string, window: CodeHealthWindow, tab: CodeHealthTab): CodeHealthView {
    this.repo(repoId);
    if (tab === "overview") {
      const revision = this.store.codeHealthRevision(repoId),
        cached = this.recommendationRefresh.get(repoId),
        at = this.now();
      if (!cached || cached.revision !== revision || at - cached.at >= CACHE_MS) {
        this.store.refreshCodeHealthRecommendations(repoId, at);
        if (this.recommendationRefresh.size >= CACHE_MAX) {
          const first = this.recommendationRefresh.keys().next().value;
          if (first) this.recommendationRefresh.delete(first);
        }
        this.recommendationRefresh.set(repoId, {
          revision: this.store.codeHealthRevision(repoId),
          at,
        });
      }
    }
    return this.store.codeHealthSnapshot(() => this.build(repoId, window, tab));
  }

  private build(repoId: string, window: CodeHealthWindow, tab: CodeHealthTab): CodeHealthView {
    this.repo(repoId);
    const at = this.now();
    const bounds = codeHealthWindowBounds(window, at);
    const revision = this.store.codeHealthRevision(repoId);
    const key = JSON.stringify([repoId, window, tab]);
    const cached = this.cache.get(key);
    if (cached?.revision === revision && cached.expires > at) return structuredClone(cached.value);
    const coverage: CodeHealthCoverage[] = [];
    const evidence: CodeHealthEvidenceRef[] = [];
    const base = { repoId, from: bounds.from, until: bounds.until, revision };
    const describe = (
      source: string,
      first: number | null,
      last: number | null,
      note: string,
      state: CodeHealthCoverage["state"] = first === null ? "empty" : "available",
      analysedSha: string | null = null,
    ): CodeHealthCoverage => {
      const item: CodeHealthCoverage = {
        state,
        requestedWindow: window,
        ...bounds,
        observedFrom: first,
        observedUntil: last,
        collectedAt: last,
        analysedSha,
        source,
        complete: first !== null && first <= bounds.from,
        note,
      };
      coverage.push(item);
      return item;
    };
    let data: CodeHealthView["data"];
    if (tab === "overview" || tab === "review") {
      const source = this.store.codeHealthReviews(repoId, bounds.from, bounds.until);
      const reviewCoverage = describe(
        "reported reviews and findings",
        source.observedFrom,
        source.observedUntil,
        "Rates describe observed reported PRs. Earlier unobserved periods are not zero.",
      );
      const review = {
        ...codeHealthReviewRounds(source.reviews, repoId),
        ...codeHealthFindingCategories(source.findings, repoId),
      };
      evidence.push(
        this.reference(
          { ...base, kind: "review-rounds" },
          "Reported review cohort",
          "Distinct PRs with a reported review in this window, grouped by maximum reported round.",
          reviewCoverage,
        ),
      );
      evidence.push(
        this.reference(
          { ...base, kind: "findings" },
          "Finding categories and resolutions",
          "Distinct finding identities in parent reported reviews; disposition, resolution and carry remain separate.",
          reviewCoverage,
        ),
      );
      if (tab === "overview") {
        const recommendations = this.store
          .codeHealthRecommendations(repoId)
          .filter(
            (row) =>
              row.active &&
              (row.state.kind === "proposed" ||
                (row.state.kind === "snoozed" && row.state.until <= at)),
          );
        const priority = (rule: string) =>
          rule === "recurring-correction" ? 0 : rule === "repeated-rounds" ? 1 : 2;
        recommendations.sort(
          (a, b) =>
            priority(a.rule) - priority(b.rule) ||
            (b.target.baseline ?? 0) - (a.target.baseline ?? 0) ||
            a.id.localeCompare(b.id),
        );
        describe(
          "recommendations",
          at,
          at,
          "Up to three conservative 30-day triage proposals. Durable decisions and accepted baselines are available from the recommendation history reader. No causal effect is inferred.",
        );
        data = {
          tab,
          recommendations: recommendations
            .slice(0, 3)
            .map((row) => ({ ...row, evidence: [...evidence] })),
          review,
        };
      } else data = { tab, review };
    } else if (tab === "risk") {
      const checkout = this.checkout(repoId);
      const sizes = checkout ? this.store.codeHealthSizes(checkout) : null;
      const observedReviews = this.store.codeHealthReviews(repoId, bounds.from, bounds.until);
      const byFile = new Map<string, number>();
      for (const finding of observedReviews.findings) {
        if (finding.file) byFile.set(finding.file, (byFile.get(finding.file) ?? 0) + 1);
      }
      const findingCoverage = describe(
        "findings on recorded file paths",
        observedReviews.observedFrom,
        observedReviews.observedUntil,
        "Finding counts describe observed reported reviews, including findings outside a PR diff. Incidence is unavailable without complete changed-file membership.",
      );
      const sizeCoverage = describe(
        "cached file-size snapshot",
        null,
        null,
        sizes
          ? "Largest 50 files at the analysed SHA. Snapshot collection time is not recorded."
          : "A file-size snapshot has not been collected for this repo.",
        sizes ? "available" : "not-collected",
        sizes?.analysedSha ?? null,
      );
      let sizeRef: CodeHealthEvidenceRef | undefined;
      if (sizes) {
        sizeRef = this.reference(
          { ...base, kind: "sizes", sha: sizes.analysedSha },
          "File-size snapshot",
          "Current line counts at one SHA; size alone does not establish growth or risk.",
          sizeCoverage,
        );
        evidence.push(sizeRef);
      }
      describe(
        "windowed file change and history",
        null,
        null,
        "Dated touches, complete changed-file denominators, numstats and comparable size history are not collected.",
        "not-collected",
      );
      data = {
        tab,
        files:
          sizes?.files.map((file) => {
            const refs = sizeRef ? [sizeRef] : [];
            if (observedReviews.reviews.length) {
              const findingRef = this.reference(
                { ...base, kind: "findings", file: file.path },
                `Findings: ${file.path}`,
                "Findings recorded for this file in the selected reported-review window.",
                findingCoverage,
              );
              refs.push(findingRef);
            }
            return {
              ...file,
              analysedSha: sizes.analysedSha,
              mergedPrTouches: null,
              additions: null,
              deletions: null,
              findings: observedReviews.reviews.length ? (byFile.get(file.path) ?? 0) : null,
              incidence: null,
              evidence: refs,
            };
          }) ?? [],
        sizeHistory: [],
        coupling: [],
      };
    } else {
      const source = this.store.codeHealthCi(repoId, bounds.from, bounds.until);
      const ciCoverage = describe(
        "CI job observations",
        source.observedFrom,
        source.observedUntil,
        `${source.observations} job observations. Mixed outcomes are candidates; attempt order and causes are not established.`,
      );
      evidence.push(
        this.reference(
          { ...base, kind: "ci" },
          "CI job observations",
          "Stored job states grouped by repo, SHA, workflow and job. These are not named-test attempts.",
          ciCoverage,
        ),
      );
      const durationCoverage = describe(
        "test identity, duration and QA collection",
        null,
        null,
        `${source.unnormalisedCommandRecords} review-command records have undocumented duration units. Stable test IDs and evidenced QA proposals need collection.`,
        "not-collected",
      );
      evidence.push(
        this.reference(
          { ...base, kind: "durations" },
          "Unnormalised command evidence",
          "Raw command results do not provide a unique test-attempt denominator or documented duration unit.",
          durationCoverage,
        ),
      );
      data = {
        tab,
        mixedJobCandidates: source.observations ? source.mixedJobCandidates : null,
        namedTestRate: null,
        disruption: [],
        durations: [],
        qaProposals: [],
      };
    }
    const value: CodeHealthView = { repoId, window, generatedAt: at, coverage, evidence, data };
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, { revision, expires: at + CACHE_MS, value });
    return structuredClone(value);
  }

  /** References are issued for this reader's bounded snapshots, never arbitrary SQL or paths. */
  evidence(repoId: string, id: string, cursor: string | undefined) {
    return this.store.codeHealthSnapshot(() => this.evidencePage(repoId, id, cursor));
  }

  private evidencePage(repoId: string, id: string, cursor: string | undefined) {
    this.repo(repoId);
    const query = this.evidenceQueries.get(id);
    if (!query || query.repoId !== repoId)
      throw new CodeHealthReadError(
        404,
        "This code-health evidence reference is unavailable. Refresh the summary.",
      );
    if (query.revision !== this.store.codeHealthRevision(repoId))
      throw new CodeHealthReadError(
        409,
        "The evidence source changed. Refresh the code-health summary.",
      );
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= 20_000 ||
      offset % CODE_HEALTH_EVIDENCE_PAGE_MAX !== 0 ||
      (cursor !== undefined && !/^(0|[1-9][0-9]*)$/.test(cursor))
    )
      throw new CodeHealthReadError(400, "Invalid code-health evidence cursor");
    const limit = CODE_HEALTH_EVIDENCE_PAGE_MAX;
    const rows = this.store.codeHealthEvidence({
      ...query,
      offset,
      limit,
      checkout: this.checkout(repoId),
    });
    const more = rows.length > limit;
    const atLimit = offset + limit >= 20_000;
    return {
      reference: query.reference,
      kind: query.kind,
      rows: rows.slice(0, limit),
      nextCursor: more && !atLimit ? String(offset + limit) : null,
      truncated: more && atLimit,
    };
  }
}
