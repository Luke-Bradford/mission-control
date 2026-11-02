import type { CodeHealthCoverage, CodeHealthEvidenceRef, CodeHealthView } from "@mc/core";
import { useMemo, useState } from "react";
import { percent } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";

type Risk = Extract<CodeHealthView["data"], { tab: "risk" }>;
type Sort = "path" | "lines" | "mergedPrTouches" | "findings";
const isTest = (path: string) =>
  /(?:^|\/)(?:__tests__|tests?|spec)\/|\.(?:test|spec)\.[^/]+$/i.test(path);
const number = (value: number | null) => (value === null ? "—" : value.toLocaleString("en-GB"));
const day = (at: number) =>
  new Date(at).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });

/** Measured inputs stay separate. No composite risk score or inferred historical points. */
export function CodeRisk({
  data,
  window,
  coverage,
  repo,
  onInspect,
}: {
  data: Risk;
  window: CodeHealthView["window"];
  coverage: CodeHealthCoverage[];
  repo: string;
  onInspect: (
    title: string,
    refs: CodeHealthEvidenceRef[],
    coverage?: CodeHealthCoverage[],
  ) => void;
}) {
  const [tests, setTests] = useState(false),
    [sort, setSort] = useState<Sort>("lines"),
    [ascending, setAscending] = useState(false);
  const rows = useMemo(
    () =>
      data.files
        .filter((row) => tests || !isTest(row.path))
        .sort((a, b) => {
          if (sort === "path") return (ascending ? 1 : -1) * a.path.localeCompare(b.path);
          const left = a[sort],
            right = b[sort];
          if (left === null) return right === null ? a.path.localeCompare(b.path) : 1;
          if (right === null) return -1;
          return (ascending ? left - right : right - left) || a.path.localeCompare(b.path);
        }),
    [data, tests, sort, ascending],
  );
  const visible = new Set(rows.map((row) => row.path));
  const histories = data.sizeHistory
    .filter((row) => visible.has(row.path) && row.points.length > 0)
    .slice(0, 4);
  const maxLines = Math.max(
    1,
    ...histories.flatMap((row) => row.points.map((point) => point.lines)),
  );
  const times = histories.flatMap((row) => row.points.map((point) => point.at));
  const starts = [...coverage.map((row) => row.from), ...times];
  const start = starts.length ? Math.min(...starts) : 0,
    end = Math.max(start + 1, ...coverage.map((row) => row.until), ...times);
  const couples = data.coupling
    .filter((row) => tests || (!isTest(row.left) && !isTest(row.right)))
    .slice()
    .sort((a, b) => b.sharedPrs - a.sharedPrs || a.left.localeCompare(b.left));
  const order = (key: Sort) => {
    setAscending(sort === key ? !ascending : key === "path");
    setSort(key);
  };
  const heading = (key: Sort, text: string) => (
    <th
      scope="col"
      className={key === "path" ? undefined : "ch-number"}
      aria-sort={sort === key ? (ascending ? "ascending" : "descending") : "none"}
    >
      <button type="button" onClick={() => order(key)}>
        {text}
        {sort === key ? (ascending ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );
  const max = (key: "lines" | "mergedPrTouches" | "findings") =>
    Math.max(1, ...rows.map((row) => row[key] ?? 0));
  const maxima = {
    lines: max("lines"),
    mergedPrTouches: max("mergedPrTouches"),
    findings: max("findings"),
  };
  const cell = (value: number | null, maximum: number) => (
    <td className="ch-number">
      <span>{number(value)}</span>
      <span className="ch-risk-bar" aria-hidden="true">
        <span style={{ width: `${(100 * (value ?? 0)) / maximum}%` }} />
      </span>
    </td>
  );
  return (
    <div className="ch-risk">
      <Panel
        title="Which files warrant a closer look?"
        sub={`Current measured size · ${window} merged-PR touches and findings · independent inputs`}
      >
        <div className="ch-risk-toolbar">
          <label>
            <input
              type="checkbox"
              checked={tests}
              onChange={(event) => setTests(event.target.checked)}
            />
            Include test files
          </label>
          <span className="ch-secondary">
            {rows.length} of {data.files.length} supplied files · size alone does not justify
            splitting a file
          </span>
        </div>
        {!rows.length ? (
          <p className="pb">
            No scoped files are available for these filters. Inspect coverage to distinguish missing
            collection from an empty observed cohort.
          </p>
        ) : (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded table needs keyboard scrolling.
          <section className="ch-risk-table" aria-label="File risk measurements" tabIndex={0}>
            <table>
              <caption>
                Unknown measures are —. Click a file to inspect its snapshots, touching PRs and
                findings.
              </caption>
              <thead>
                <tr>
                  {heading("path", "File")}
                  {heading("lines", "Lines")}
                  {heading("mergedPrTouches", `${window} PR touches`)}
                  {heading("findings", `${window} findings`)}
                  <th scope="col">Size history</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const history = data.sizeHistory.find((value) => value.path === row.path);
                  return (
                    <tr key={row.path}>
                      <th scope="row">
                        <button
                          type="button"
                          className="ch-risk-path"
                          title={row.path}
                          onClick={() => onInspect(row.path, row.evidence, coverage)}
                        >
                          {row.path}
                          <span aria-hidden="true" className="ch-secondary">
                            {row.analysedSha
                              ? ` · ${row.analysedSha.slice(0, 8)}`
                              : " · size not collected"}
                          </span>
                        </button>
                      </th>
                      {cell(row.lines, maxima.lines)}
                      {cell(row.mergedPrTouches, maxima.mergedPrTouches)}
                      {cell(row.findings, maxima.findings)}
                      <td>
                        {history?.points.length ? (
                          <button
                            type="button"
                            onClick={() =>
                              onInspect(
                                `Size observations: ${row.path}`,
                                history.evidence,
                                coverage,
                              )
                            }
                          >
                            {history.points.length}{" "}
                            {history.points.length === 1 ? "snapshot" : "snapshots"}
                          </button>
                        ) : (
                          <span className="ch-secondary">Not collected</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}
        <div className="ch-risk-toolbar">
          <button type="button" onClick={() => onInspect("File collection coverage", [], coverage)}>
            Inspect collection coverage
          </button>
          <a href={`/map/${encodeURIComponent(repo)}`} target="_blank" rel="noreferrer">
            Open repo in Map
          </a>
          <span className="ch-secondary">
            Map has its own fixed 90-day history; this selection stays open.
          </span>
        </div>
      </Panel>
      <div className="ch-risk-lower">
        <Panel
          title="Measured size observations"
          sub={`Up to four files · common 0–${number(maxLines)} line scale · dates and SHAs retained`}
        >
          {!histories.length ? (
            <p className="pb">
              Size history is not collected for these files. Today's size cannot establish growth or
              pre-rename history.
            </p>
          ) : (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users can scroll the retained small multiples.
            <section className="ch-risk-histories" aria-label="Retained size charts" tabIndex={0}>
              {histories.map((history) => (
                <section key={history.path}>
                  <button
                    type="button"
                    className="ch-risk-path"
                    title={history.path}
                    onClick={() =>
                      onInspect(`Size observations: ${history.path}`, history.evidence, coverage)
                    }
                  >
                    {history.path}
                  </button>
                  <svg
                    viewBox="0 0 240 64"
                    role="img"
                    aria-label={`${history.path}: ${history.points.map((point) => `${number(point.lines)} lines on ${day(point.at)} at ${point.sha.slice(0, 8)}`).join("; ")}. ${history.comparable ? "Comparable snapshots." : "Not a comparable growth series."}`}
                  >
                    <path d="M8 4V56H232" className="ch-risk-axis" />
                    {history.comparable && history.points.length > 1 && (
                      <polyline
                        className="ch-risk-line"
                        points={history.points
                          .map(
                            (point) =>
                              `${8 + 224 * Math.max(0, Math.min(1, (point.at - start) / Math.max(1, end - start)))},${56 - (48 * point.lines) / maxLines}`,
                          )
                          .join(" ")}
                      />
                    )}
                    {history.points.map((point) => (
                      <circle
                        key={`${point.sha}-${point.at}`}
                        cx={
                          8 +
                          224 *
                            Math.max(0, Math.min(1, (point.at - start) / Math.max(1, end - start)))
                        }
                        cy={56 - (48 * point.lines) / maxLines}
                        r="3"
                      >
                        <title>{`${point.sha}: ${number(point.lines)} lines, ${day(point.at)} UTC`}</title>
                      </circle>
                    ))}
                  </svg>
                  <p className="ch-secondary">
                    {history.points.length < 2
                      ? "One observation · growth unknown"
                      : history.comparable
                        ? "Comparable collection scope"
                        : "Scope or current point differs · no trend"}
                  </p>
                  <div className="ch-risk-point-labels">
                    {history.points.map((point) => (
                      <button
                        type="button"
                        key={`${point.sha}-${point.at}`}
                        title={point.sha}
                        onClick={() =>
                          onInspect(`Snapshot ${point.sha}`, history.evidence, coverage)
                        }
                      >
                        {day(point.at)} · {point.sha.slice(0, 8)}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </section>
          )}
        </Panel>
        <Panel
          title="Files changing together"
          sub={`${window} shared PRs · share of the less frequently changed file's eligible PRs`}
        >
          {!couples.length ? (
            <p className="pb">
              No qualifying pairs are available for these filters. Coupling needs complete observed
              diffs, at least four shared PRs and at least 50% share.
            </p>
          ) : (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded table needs keyboard scrolling.
            <section className="ch-risk-coupling" aria-label="Paired-file coupling" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Paired files</th>
                    <th scope="col" className="ch-number">
                      Shared PRs ↓
                    </th>
                    <th scope="col" className="ch-number">
                      Share
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {couples.slice(0, 6).map((row) => (
                    <tr key={JSON.stringify([row.left, row.right])}>
                      <th scope="row">
                        <button
                          type="button"
                          className="ch-risk-path"
                          title={`${row.left}\n${row.right}`}
                          onClick={() =>
                            onInspect(
                              `Coupling: ${row.left} + ${row.right}`,
                              row.evidence,
                              coverage,
                            )
                          }
                        >
                          {row.left}
                          <br />
                          {row.right}
                        </button>
                      </th>
                      <td className="ch-number">{row.sharedPrs}</td>
                      <td
                        className="ch-number"
                        title={`${row.sharedPrs} of ${row.lessFrequentlyChangedFilePrs} eligible PRs`}
                      >
                        {percent(row.sharePercent, 1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          <p className="ch-secondary pb">
            Showing {Math.min(6, couples.length)} of {couples.length} qualifying pairs. Diffs with
            more than {couples[0]?.excludedBroadPrThreshold ?? 25} raw paths are excluded before
            scope filtering. Shared changes are an investigation input, not a defect score.
          </p>
        </Panel>
      </div>
    </div>
  );
}
