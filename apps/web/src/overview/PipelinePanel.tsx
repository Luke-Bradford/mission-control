import type { Crew, OverviewSummary, PipelineStage } from "@mc/core";
import { type CSSProperties, useState } from "react";
import { Toggle } from "../components/Expandable.tsx";
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

/** The hub sends this many cards per stage; the lane shows the first few and expands in place. */
const VISIBLE_CARDS = 8;
const COLLAPSED_CARDS = 3;

/** Where a pipeline card leads: the ticket's panel on the Board. One place to change it. */
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  return (
    <Panel id="pipelineP" title="Pipeline">
      {error && <p className="pb crit-t">{error.message}</p>}

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
          const loaded = stageCards.slice(0, VISIBLE_CARDS);
          const open = expanded.has(key);
          const cards = open ? loaded : loaded.slice(0, COLLAPSED_CARDS);
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
                <span className="num">{data ? count : "—"}</span>
              </h3>
              {!data &&
                !error &&
                Array.from({ length: VISIBLE_CARDS }, (_, i) => (
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
                      {card.title}
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
              {loaded.length > COLLAPSED_CARDS && (
                <Toggle
                  on={open}
                  of={label}
                  onClick={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (!next.delete(key)) next.add(key);
                      return next;
                    })
                  }
                />
              )}
              {more > 0 && (
                <a
                  className="pipeline-more mono xs"
                  href={stageHref}
                  onClick={(e) => followLink(e, stageHref)}
                >
                  +{more} · open Board ›
                </a>
              )}
            </section>
          );
        })}
      </div>
    </Panel>
  );
}
