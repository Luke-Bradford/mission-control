import type { Telemetry } from "@mc/core";
import { Panel } from "../hud/Panel.tsx";
import { DASH } from "./common.ts";

type RepoWeek = NonNullable<Telemetry["repoWeeks"]>[number]["weeks"][number];

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return String(Math.round(tokens));
}

function hours(hours: number): string {
  return `${hours.toFixed(1).replace(/\.0$/, "")} h`;
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

function tokensPerPr(week: RepoWeek): string {
  if (week.mergedPrs === 0) return "No merged PRs";
  const { claude, codex } = week.tokensPerMergedPr;
  if (claude === null && codex === null) return DASH;
  const values = [claude, codex].filter((value): value is number => value !== null);
  return [
    `${compactTokens(values.reduce((sum, value) => sum + value, 0))} total`,
    claude !== null && `Claude ${compactTokens(claude)}`,
    codex !== null && `Codex ${compactTokens(codex)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function baselineLabel(baseline: NonNullable<Telemetry["repoWeeks"]>[number]["baseline"]): string {
  return baseline === null
    ? "Baseline not configured"
    : `${baseline.mergedPrsPerWeek} PRs/wk · ${compactTokens(baseline.tokensPerWeek)} tokens/wk`;
}

/** Four ISO weeks of delivery and capacity figures, compared with the configured loop baseline. */
export function RepoScoreboard({ repoWeeks }: { repoWeeks: Telemetry["repoWeeks"] | undefined }) {
  return (
    <Panel
      id="tRepoScoreboard"
      title="Repository throughput"
      sub="four ISO weeks · tokens per merged PR"
      className="repo-scoreboard"
    >
      {!repoWeeks ? (
        <p className="pb s muted">Repository comparison is loading.</p>
      ) : repoWeeks.length === 0 ? (
        <p className="pb s muted">No repository telemetry is configured yet.</p>
      ) : (
        <section className="pb repo-scoreboard-scroll" aria-label="Repository throughput weeks">
          {repoWeeks.map((repo) => (
            <section
              className="repo-scoreboard-repo"
              key={repo.repoId}
              aria-label={`${repo.repoId} throughput`}
            >
              <header>
                <b>{repo.repoId}</b>
                <span>Loop baseline: {baselineLabel(repo.baseline)}</span>
              </header>
              {repo.weeks.length === 0 ? (
                <p className="s muted">No weekly figures collected yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Week</th>
                      <th className="r">Merged</th>
                      <th className="r">Tokens / PR</th>
                      <th className="r">Review rounds / PR</th>
                      <th className="r">Ready to merge</th>
                      <th className="r">Ready, no seat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repo.weeks.map((week) => (
                      <tr key={week.week}>
                        <th scope="row">{weekLabel(week.week)}</th>
                        <td className="r num">{week.mergedPrs}</td>
                        <td className="r num">{tokensPerPr(week)}</td>
                        <td className="r num">
                          {week.reviewRoundsPerPr === null
                            ? DASH
                            : week.reviewRoundsPerPr.toFixed(1)}
                        </td>
                        <td className="r num">
                          {week.medianReadyToMergeHours === null
                            ? DASH
                            : hours(week.medianReadyToMergeHours)}
                        </td>
                        <td className="r num">
                          {week.noSeatWorkingHours === null ? DASH : hours(week.noSeatWorkingHours)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}
        </section>
      )}
    </Panel>
  );
}
