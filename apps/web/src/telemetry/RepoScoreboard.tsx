import type { Telemetry } from "@mc/core";
import { useLayoutEffect, useRef, useState } from "react";
import { Panel } from "../hud/Panel.tsx";
import { DASH } from "./common.ts";

type RepoWeek = NonNullable<Telemetry["repoWeeks"]>[number]["weeks"][number];
type RepoBaseline = NonNullable<Telemetry["repoWeeks"]>[number]["baseline"];

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return String(Math.round(tokens));
}

function compactTokenRange(range: { min: number; max: number }): string {
  if (range.min === range.max) return compactTokens(range.min);
  if (range.max >= 1_000_000_000 && range.min >= 1_000_000_000)
    return `${(range.min / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}–${(range.max / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (range.max >= 1_000_000 && range.min >= 1_000_000)
    return `${(range.min / 1_000_000).toFixed(1).replace(/\.0$/, "")}–${(range.max / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `${compactTokens(range.min)}–${compactTokens(range.max)}`;
}

function hours(value: number): string {
  return `${value.toFixed(1).replace(/\.0$/, "")} h`;
}

function weekLabel(week: string): string {
  const date = new Date(`${week}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? week
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(date);
}

function baselineTokensPerPr(baseline: RepoBaseline): string | null {
  if (baseline === null) return null;
  return compactTokenRange({
    min: baseline.tokensPerWeek.min / baseline.mergedPrsPerWeek.max,
    max: baseline.tokensPerWeek.max / baseline.mergedPrsPerWeek.min,
  });
}

function baselineLabel(baseline: RepoBaseline): string {
  const range = (
    value: { min: number; max: number },
    format: (number: number) => string,
  ): string =>
    value.min === value.max ? format(value.min) : `${format(value.min)}–${format(value.max)}`;
  return baseline === null
    ? "Baseline not configured"
    : `${range(baseline.mergedPrsPerWeek, String)} PR/wk · ${compactTokenRange(baseline.tokensPerWeek)}/wk · ${baselineTokensPerPr(baseline)}/PR`;
}

function WeekCell({ week }: { week: RepoWeek }) {
  if (week.mergedPrs === 0) return <span className="repo-scoreboard-empty">No merged PRs</span>;
  const { claude, codex } = week.tokensPerMergedPr;
  const vendors = [
    claude !== null && `Claude ${compactTokens(claude)}`,
    codex !== null && `Codex ${compactTokens(codex)}`,
  ].filter((vendor): vendor is string => vendor !== false);
  const total = [claude, codex].reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return (
    <span className="repo-scoreboard-week">
      <b>{`${week.mergedPrs} merged · ${compactTokens(total)}/PR`}</b>
      <br />
      <span>
        {vendors.map((vendor) => vendor.replace("Claude ", "C").replace("Codex ", "X")).join(" · ")}{" "}
        · {week.reviewRoundsPerPr === null ? DASH : `${week.reviewRoundsPerPr.toFixed(1)}r`} ·{" "}
        {week.medianReadyToMergeHours === null ? DASH : hours(week.medianReadyToMergeHours)} ·{" "}
        {week.noSeatWorkingHours === null ? DASH : hours(week.noSeatWorkingHours)}
      </span>
    </span>
  );
}

/** Four complete seven-day periods of delivery and capacity figures, compared with the configured loop baseline. */
export function RepoScoreboard({ repoWeeks }: { repoWeeks: Telemetry["repoWeeks"] | undefined }) {
  const scroll = useRef<HTMLElement>(null);
  const [horizontalOverflow, setHorizontalOverflow] = useState(false);
  const hasOverflow = (repoWeeks?.length ?? 0) > 4 || horizontalOverflow;

  useLayoutEffect(() => {
    const region = scroll.current;
    if (region === null) return;
    const measure = () => setHorizontalOverflow(region.scrollWidth > region.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    return () => observer.disconnect();
  }, [repoWeeks]);

  return (
    <Panel
      id="tRepoScoreboard"
      title="Repository throughput"
      sub="four complete weeks · C Claude · X Codex · r review rounds · h Ready / idle hours"
      className="repo-scoreboard"
    >
      {!repoWeeks ? (
        <p className="pb s muted">Repository comparison is loading.</p>
      ) : repoWeeks.length === 0 ? (
        <p className="pb s muted">No repository telemetry is configured yet.</p>
      ) : (
        <>
          <section
            ref={scroll}
            className={`pb repo-scoreboard-scroll${hasOverflow ? " has-overflow" : ""}`}
            aria-label="Repository throughput weeks"
            tabIndex={hasOverflow ? 0 : undefined}
          >
            <table>
              <colgroup>
                <col className="repo-scoreboard-name-column" />
                <col className="repo-scoreboard-baseline-column" />
                {repoWeeks[0]?.weeks.map((week) => (
                  <col key={week.week} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Loop baseline</th>
                  {repoWeeks[0]?.weeks.map((week) => (
                    <th
                      key={week.week}
                      title="Merged PRs · tokens per PR · Claude / Codex · review rounds · Ready hours · idle hours"
                    >
                      {weekLabel(week.week)}
                      <br />
                      PR · C/X · r · h
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {repoWeeks.map((repo) => (
                  <tr className="repo-scoreboard-repo" key={repo.repoId}>
                    <th scope="row">
                      <span className="repo-scoreboard-repo-name">{repo.repoId}</span>
                    </th>
                    <td>{baselineLabel(repo.baseline)}</td>
                    {repo.weeks.map((week) => (
                      <td key={week.week}>
                        <WeekCell week={week} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <p className="repo-scoreboard-cue">
            {repoWeeks.length} repositories ·{" "}
            {hasOverflow ? "scroll to compare all" : "all visible"}
          </p>
        </>
      )}
    </Panel>
  );
}
