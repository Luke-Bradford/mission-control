import type { Crew, OverviewSummary, PipelineCard, PipelineStage } from "@mc/core";
import type { CSSProperties } from "react";
import { useNow } from "../clock.ts";
import { callSign } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { elapsed, percent } from "../fmt.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { metricTitle, useMetrics } from "../metrics.ts";
import { followLink, PAGE_PATHS, ticketPath } from "../router.ts";
import { useSession } from "../shell/session.ts";

/**
 * Lane titles. The building-and-checks lane is "Building · checks", not "In progress": the registry's In
 * progress (METRICS.inProgress) is every lane from Building to Merging.
 */
export const PIPELINE_STAGES = {
  ready: "Ready",
  progress: "Building · checks",
  review: "In review",
  merging: "Merging",
  merged: "Done · 24h",
} as const;

export type PipelineLane = keyof typeof PIPELINE_STAGES;

export const PIPELINE_LANE_STAGES: Record<PipelineLane, readonly PipelineStage["stage"][]> = {
  ready: ["ready"],
  progress: ["building", "checks"],
  review: ["review"],
  merging: ["merging"],
  merged: ["merged"],
};

const DASH = "—";

/** Where a pipeline card leads: the ticket's panel on the Board. One place to change it. */
/**
 * A card's title without its own number: a merged card carries its pull request's title, which often
 * ends in `(#n)` or starts with `#n`, and the card already shows the ticket number beside it.
 */
export function cardTitle(card: { ticket: number; pr: number | null; title: string }): string {
  const numbers = [card.ticket, card.pr].filter((n): n is number => n !== null);
  let title = card.title;
  for (const n of numbers) {
    title = title
      .replace(new RegExp(`\\s*\\(#${n}\\)\\s*$`), "")
      .replace(new RegExp(`^#${n}\\s+`), "");
  }
  return title.trim() || card.title;
}

export const pipelineCardPath = (card: { repoId: string; ticket: number }): string =>
  ticketPath(card.repoId, card.ticket);

function assignee(
  who: string | null,
  crew: Crew | undefined,
): { name: string; index: number } | null {
  if (who === null) return null;
  const row = crew?.rows.find((candidate) => candidate.id === who);
  return { name: row ? callSign(row) : who, index: row?.index ?? 0 };
}

export function PipelinePanel() {
  const [session] = useSession();
  const { data, error } = useResource<OverviewSummary>(RESOURCES.overview(session));
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const metrics = useMetrics();
  const now = useNow();
  const r = metrics.readings;
  const ci = data?.kpis?.ciPassRate24h;
  return (
    <Panel
      id="pipelineP"
      title={
        <a href={PAGE_PATHS.board} onClick={(e) => followLink(e, PAGE_PATHS.board)}>
          Board
        </a>
      }
      sub={
        <>
          <b data-metric="inProgress" title={metricTitle(metrics, "inProgress")}>
            {r.inProgress?.value ?? DASH}
          </b>{" "}
          in flight ·{" "}
          <b data-metric="merged" title={metricTitle(metrics, "merged")}>
            {r.merged?.value ?? DASH}
          </b>{" "}
          merged in 24h · cycle{" "}
          <b data-metric="cycleTime" title={metricTitle(metrics, "cycleTime")}>
            {r.cycleTime?.value ?? DASH}
          </b>{" "}
          · CI <b>{percent(ci?.pct)}</b>
          {ci?.runs ? ` of ${ci.runs} runs` : ""}
          {ci?.redNow ? <span className="crit-t"> · {ci.redNow} red now</span> : null}
        </>
      }
    >
      {error && (
        <p role="status" className="pb crit-t">
          {data
            ? "Board refresh failed. Showing the last received cards."
            : "Board could not load."}
        </p>
      )}
      <div className="board-stages" aria-busy={!data && !error}>
        {Object.entries(PIPELINE_STAGES).map(([key, label]) => {
          const lane = key as PipelineLane;
          const stages = (data?.pipeline ?? []).filter((stage) =>
            PIPELINE_LANE_STAGES[lane].includes(stage.stage),
          );
          const cards = stages.flatMap((stage) => stage.cards ?? []);
          const count = stages.reduce((total, stage) => total + stage.count, 0);
          const oldest = Math.min(
            ...stages.flatMap((stage) => (stage.oldestAt === null ? [] : [stage.oldestAt])),
          );
          const stageHref = `${PAGE_PATHS.board}?stage=${key}`;
          return (
            <section key={key} className={`board-stage ${key}`} aria-label={label}>
              <h3>
                <a href={stageHref} onClick={(e) => followLink(e, stageHref)}>
                  {label}
                </a>
                <b className="num">{data ? count : DASH}</b>
                {key !== "merged" && Number.isFinite(oldest) && (
                  <span className="board-oldest">oldest {elapsed(now - oldest)}</span>
                )}
              </h3>
              <div className="board-cards scroll">
                {data && count === 0 && <p className="s muted board-empty">No tickets here.</p>}
                {cards.map((card) => {
                  const owner = assignee(card.who, crew);
                  const href = pipelineCardPath(card);
                  return (
                    <a
                      key={`${key}:${card.repoId}#${card.ticket}:${card.pr}`}
                      className="board-card"
                      href={href}
                      onClick={(e) => followLink(e, href)}
                    >
                      <span className="board-title" title={card.title}>
                        <span className="board-ticket num">#{card.ticket}</span> {cardTitle(card)}
                      </span>
                      <span className="board-meta">
                        {owner && (
                          <span className="pipeline-assignee" title={owner.name}>
                            <i
                              style={{ "--c": agentColor(owner.index) } as CSSProperties}
                              aria-hidden="true"
                            />
                            <span>{owner.name}</span>
                          </span>
                        )}
                        {card.priority && <b className="board-tag">{card.priority}</b>}
                        {card.size && <span className="board-tag">{card.size}</span>}
                        {card.pr !== null && <span className="num">PR {card.pr}</span>}
                        {card.ci.length > 0 && <CiMarks ci={card.ci} />}
                        <span className="board-age num">{elapsed(now - card.since)}</span>
                      </span>
                    </a>
                  );
                })}
                {count > cards.length && (
                  <a
                    className="board-more s"
                    href={stageHref}
                    onClick={(e) => followLink(e, stageHref)}
                  >
                    {count - cards.length} more on the Board
                  </a>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </Panel>
  );
}

/** A PR's checks as marks: shape as well as colour, with the count in words for a reader. */
function CiMarks({ ci }: { ci: PipelineCard["ci"] }) {
  const passed = ci.filter((check) => check === "pass").length;
  const failed = ci.filter((check) => check === "fail").length;
  const label = `CI: ${passed} of ${ci.length} passed${failed ? `, ${failed} failed` : ""}`;
  return (
    <span className="ci-marks" role="img" aria-label={label} title={label}>
      {ci.map((check, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: checks have no identity here, only their result
        <i key={i} className={`ci-${check}`} />
      ))}
    </span>
  );
}
