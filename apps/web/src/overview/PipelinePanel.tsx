import type { Crew, OverviewSummary, PipelineStage } from "@mc/core";
import type { CSSProperties } from "react";
import { callSign } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { followLink, ticketPath } from "../router.ts";
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
  merged: "Done today",
} as const;

export type PipelineLane = keyof typeof PIPELINE_STAGES;

export const PIPELINE_LANE_STAGES: Record<PipelineLane, readonly PipelineStage["stage"][]> = {
  ready: ["ready"],
  progress: ["building", "checks"],
  review: ["review"],
  merging: ["merging"],
  merged: ["merged"],
};

/** A compact summary keeps one measured example; its heading opens the complete Board lane. */
const COLLAPSED_CARDS = 1;

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
  const hasWork = data?.pipeline?.some((stage) => stage.count > 0) ?? false;
  return (
    <Panel
      id="pipelineP"
      title="Pipeline"
      sub="Current ticket lanes · open Board for the complete lane"
    >
      {error && (
        <p role="status" className="pb crit-t">
          {data
            ? "Pipeline refresh failed. Showing the last received lanes."
            : "Pipeline could not load."}
        </p>
      )}

      <div className="pipeline-grid pb scroll" aria-busy={!data && !error}>
        {Object.entries(PIPELINE_STAGES).map(([key, label]) => {
          const lane = key as PipelineLane;
          const stages = PIPELINE_LANE_STAGES[lane];
          const stageCards = stages.flatMap(
            (stage) => data?.pipeline?.find((candidate) => candidate.stage === stage)?.cards ?? [],
          );
          const count = stages.reduce(
            (total, stage) =>
              total + (data?.pipeline?.find((candidate) => candidate.stage === stage)?.count ?? 0),
            0,
          );
          const cards = stageCards.slice(0, COLLAPSED_CARDS);
          // Everything not drawn is counted, hidden loaded cards included.
          const more = count - cards.length;
          const stageHref = `/board?stage=${key}`;
          // A lane with nothing in it collapses to its header instead of holding a column's width.
          const collapsed = data !== undefined && count === 0;
          return (
            <section
              key={key}
              className={`pipeline-stage ${key}${collapsed ? " empty" : ""}`}
              aria-label={label}
            >
              <h3>
                <a href={stageHref} onClick={(e) => followLink(e, stageHref)}>
                  {label}
                </a>
              </h3>
              <p className="pipeline-counts s num">
                {data
                  ? `${count} total${more > 0 ? ` · ${more} not shown` : collapsed && !hasWork ? " · empty" : ""}`
                  : "Total not received"}
              </p>
              {collapsed && hasWork && <p className="pipeline-empty s muted">Observed empty</p>}
              {!data &&
                !error &&
                Array.from({ length: COLLAPSED_CARDS }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: identical loading placeholders
                  <div className="pipeline-chip pipeline-skeleton" key={i} aria-hidden="true">
                    <span className="kpi-skeleton" />
                  </div>
                ))}
              {cards.map((card) => {
                const owner = assignee(card.who, crew);
                const href = pipelineCardPath(card);
                return (
                  <a
                    key={`${key}:${card.repoId}#${card.ticket}:${card.pr}`}
                    className="pipeline-chip"
                    href={href}
                    onClick={(e) => followLink(e, href)}
                  >
                    <span className="pipeline-ticket num">#{card.ticket}</span>
                    <span className="pipeline-title" title={card.title}>
                      {cardTitle(card)}
                    </span>
                    {owner && (
                      <span className="pipeline-assignee" title={owner.name}>
                        <i
                          style={{ "--c": agentColor(owner.index) } as CSSProperties}
                          aria-hidden="true"
                        />
                        <span className="ellip">{owner.name}</span>
                      </span>
                    )}
                  </a>
                );
              })}
            </section>
          );
        })}
      </div>
    </Panel>
  );
}
