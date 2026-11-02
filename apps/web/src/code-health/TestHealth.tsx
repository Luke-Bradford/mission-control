import type { CodeHealthCoverage, CodeHealthEvidenceRef, CodeHealthView } from "@mc/core";
import { Panel } from "../hud/Panel.tsx";
import { date, label } from "./format.ts";
import "./TestHealth.css";

type TestData = Extract<CodeHealthView["data"], { tab: "test" }>;
type Inspect = (
  title: string,
  refs: CodeHealthEvidenceRef[],
  coverage?: CodeHealthCoverage[],
) => void;
const count = (value: number) => value.toLocaleString("en-GB");
const evidenceTitle = (prefix: string, identity: string) =>
  `${prefix}: ${identity.length > 120 ? `${identity.slice(0, 120)}…` : identity}`;
const classification = {
  candidate: "Candidate",
  "confirmed-flaky": "Confirmed flaky",
  "consistently-failing": "Consistently failing",
  infrastructure: "Infrastructure",
} as const;

/** Observations, executed attempts and reviewer judgements have independent denominators. */
export function TestHealth({
  data,
  coverage,
  evidence,
  onInspect,
}: {
  data: TestData;
  coverage: CodeHealthCoverage[];
  evidence: CodeHealthEvidenceRef[];
  onInspect: Inspect;
}) {
  const source = (name: string) => coverage.find((row) => row.source === name);
  const ci = source("CI job observations"),
    named = source("imported named-test attempts"),
    duration = source("documented test durations"),
    qa = source("evidence-backed test QA proposals");
  const inspectSource = (title: string, names: string[], item?: CodeHealthCoverage) =>
    onInspect(
      title,
      evidence.filter((row) => names.includes(row.label)),
      item ? [item] : [],
    );
  const maxFailed = Math.max(1, ...data.disruption.map((row) => row.rate?.numerator ?? 0));
  return (
    <div className="ch-test">
      <div className="ch-test-cohorts">
        <section className="ch-test-cohort" aria-label="Job observations">
          <h2>CI job observations</h2>
          <p>
            <strong className="ch-value">
              {data.mixedJobCandidates === null ? "Not collected" : count(data.mixedJobCandidates)}
            </strong>{" "}
            mixed-outcome job groups
          </p>
          <p className="ch-secondary">
            Repeated job snapshots are observations, not executed test attempts. Mixed results
            remain candidates.
          </p>
          <Source coverage={ci} />
          <button
            type="button"
            onClick={() => inspectSource("CI job observations", ["CI job observations"], ci)}
          >
            Inspect job observations
          </button>
        </section>
        <section className="ch-test-cohort" aria-label="Executed named-test attempts">
          <h2>Executed named-test attempts</h2>
          <p className="ch-test-rate">
            {data.namedTestRate ? (
              <>
                <strong className="ch-value">
                  {data.namedTestRate.percent === null
                    ? "Rate unknown"
                    : `${data.namedTestRate.percent.toLocaleString("en-GB", { maximumFractionDigits: 1 })}% failed`}
                </strong>
                <span>
                  {count(data.namedTestRate.numerator)} failed /{" "}
                  {count(data.namedTestRate.denominator)} executed attempts
                </span>
              </>
            ) : (
              <strong className="ch-value">Not collected</strong>
            )}
          </p>
          <p className="ch-secondary">
            Only passed and failed tests enter the denominator. Skipped, cancelled and not-run
            entries are excluded.
          </p>
          <Source coverage={named} />
          <button
            type="button"
            onClick={() =>
              inspectSource(
                "Named-test collection and provenance",
                ["Imported named-test attempts", "Imported report provenance"],
                named,
              )
            }
          >
            Inspect attempts and imports
          </button>
        </section>
      </div>
      <div className="ch-test-layout">
        <Panel
          title="Which test results need investigation?"
          sub="Ranked by observed failed attempts · independent classifications"
        >
          <p className="ch-test-intro ch-secondary">
            Candidate needs investigation. Confirmed flaky requires ordered recovery and linked QA
            evidence. Consistent failures and infrastructure remain separate.
          </p>
          {!data.disruption.length ? (
            <p className="pb">
              No classified disruption groups were observed. Missing or partial collection does not
              establish healthy tests.
            </p>
          ) : (
            <section
              className="ch-test-scroll ch-test-disruption"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded evidence region needs keyboard scrolling.
              tabIndex={0}
              aria-label="Ranked test disruption"
            >
              <table>
                <caption>
                  Bar scale: 0–{count(maxFailed)} failed attempts. Percentages describe the observed
                  executed cohort, never job snapshots. Select a test for its full identity and
                  evidence.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Test / exact head</th>
                    <th scope="col">Classification</th>
                    <th scope="col" className="ch-number">
                      Failed / executed
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.disruption.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">
                        <button
                          type="button"
                          className="ch-test-identity"
                          title={row.label}
                          onClick={() =>
                            onInspect(
                              evidenceTitle("Test attempts", row.label),
                              row.evidence,
                              named ? [named] : [],
                            )
                          }
                        >
                          {row.label}
                        </button>
                        <span className="ch-test-detail">
                          {row.headSha ? row.headSha.slice(0, 8) : "Head not collected"} ·{" "}
                          {row.ordered === true ? "Explicit retry order" : "Retry order uncertain"}
                        </span>
                      </th>
                      <td>
                        <span className="ch-test-classification">
                          {classification[row.classification]}
                        </span>
                      </td>
                      <td className="ch-number">
                        {row.rate ? (
                          <>
                            <strong>
                              {count(row.rate.numerator)} / {count(row.rate.denominator)}
                            </strong>
                            <span className="ch-test-detail">
                              {row.rate.percent === null
                                ? "Rate unknown"
                                : `${row.rate.percent.toLocaleString("en-GB", { maximumFractionDigits: 1 })}% failed`}
                            </span>
                            <span className="ch-test-bar" aria-hidden="true">
                              <span
                                style={{ width: `${(100 * row.rate.numerator) / maxFailed}%` }}
                              />
                            </span>
                          </>
                        ) : (
                          "Not collected"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          <Omitted count={data.omitted?.disruption} label="disruption groups" />
        </Panel>
        <div className="ch-stack">
          <Panel
            title="Which documented tests are slow?"
            sub="Nearest-rank p50 / p95 · milliseconds · separate environments"
          >
            {!data.durations.length ? (
              <p className="pb">
                Comparable durations are not collected. Unknown units or environments are never
                converted into percentiles.
              </p>
            ) : (
              <section
                className="ch-test-scroll ch-test-durations"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded evidence region needs keyboard scrolling.
                tabIndex={0}
                aria-label="Documented test durations"
              >
                <table>
                  <caption>
                    Sorted by p95. Values describe samples, not a performance budget or trend.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Test / environment</th>
                      <th scope="col" className="ch-number">
                        p50 / p95 (ms)
                      </th>
                      <th scope="col" className="ch-number">
                        Samples
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.durations.map((row) => (
                      <tr key={JSON.stringify([row.testId, row.file, row.environment])}>
                        <th scope="row">
                          <button
                            type="button"
                            className="ch-test-identity"
                            title={row.label ?? row.file}
                            onClick={() =>
                              onInspect(
                                evidenceTitle("Duration samples", row.label ?? row.file),
                                row.evidence,
                                duration ? [duration] : [],
                              )
                            }
                          >
                            {row.label ?? row.file}
                          </button>
                          <span className="ch-test-detail">
                            {row.file} · {row.environment}
                          </span>
                        </th>
                        <td className="ch-number">
                          {count(row.p50Ms)} / {count(row.p95Ms)}
                        </td>
                        <td className="ch-number">{count(row.samples)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
            <Omitted count={data.omitted?.durations} label="duration groups" />
            <div className="ch-test-foot">
              <Source coverage={duration} />
              <button
                type="button"
                onClick={() =>
                  inspectSource(
                    "Duration collection limits",
                    ["Unnormalised command evidence"],
                    duration,
                  )
                }
              >
                Inspect duration coverage
              </button>
            </div>
          </Panel>
          <Panel
            title="Evidence-backed QA proposals"
            sub="Original reviewer findings · no age-only staleness claim"
          >
            {!data.qaProposals.length ? (
              <p className="pb">
                No linked QA proposals were collected. Test age alone does not prove a test stale,
                wrong, slow or flaky.
              </p>
            ) : (
              <section
                className="ch-test-scroll ch-test-qa"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded evidence region needs keyboard scrolling.
                tabIndex={0}
                aria-label="Test QA proposals"
              >
                {data.qaProposals.map((row) => (
                  <article key={row.id}>
                    <button
                      type="button"
                      className="ch-test-identity"
                      title={row.testId}
                      onClick={() =>
                        onInspect(
                          evidenceTitle("QA code/spec evidence", row.testId),
                          row.evidence,
                          qa ? [qa] : [],
                        )
                      }
                    >
                      {row.testId}
                    </button>
                    <p>
                      <strong>{label(row.judgement)} proposal</strong> · reviewer {row.reviewer}
                    </p>
                    <p className="ch-test-detail">
                      {row.file ?? "File not collected"} ·{" "}
                      {row.headSha?.slice(0, 8) ?? "Head not collected"}
                      <br />
                      Linked {date(row.at)} by {row.recordedBy ?? "unrecorded operator"}
                    </p>
                  </article>
                ))}
              </section>
            )}
            <Omitted count={data.omitted?.qaProposals} label="QA proposals" />
            <div className="ch-test-foot">
              <Source coverage={qa} />
            </div>
            <p className="ch-test-foot ch-secondary">
              Inspect code/spec evidence first. Accept, Dismiss or Snooze matching recommendations
              on Overview.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Source({ coverage }: { coverage?: CodeHealthCoverage }) {
  return (
    <details className="ch-test-source">
      <summary>
        {coverage
          ? `${label(coverage.state)} · ${coverage.complete ? "observed cohort complete" : "partial collection"}`
          : "Collection not described"}
      </summary>
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: long collection details need keyboard scrolling.
        tabIndex={0}
        aria-label={`${coverage?.source ?? "Unknown source"} collection details`}
      >
        <p>
          {coverage?.note ??
            "Source coverage is unavailable. Inspect collection before drawing a conclusion."}
        </p>
      </section>
    </details>
  );
}
function Omitted({ count: omitted, label: name }: { count?: number; label: string }) {
  return omitted ? (
    <p className="ch-test-foot ch-secondary">
      {count(omitted)} more {name} outside the bounded summary. Inspect collection coverage; these
      rows are not a complete ranking.
    </p>
  ) : null;
}
