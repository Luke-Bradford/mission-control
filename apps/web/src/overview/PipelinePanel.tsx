import type { Crew, OverviewSummary, PipelineStage } from "@mc/core";
import type { CSSProperties } from "react";
import { callSign } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { followLink } from "../router.ts";
import { useSession } from "../shell/session.ts";

/**
 * Lane titles. The building-and-checks lane is "Building", not "In progress": the registry's In
 * progress (METRICS.inProgress) is every lane from Building to Merging.
 */
export const PIPELINE_STAGES = {
  ready: "Ready",
  progress: "Building",
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

const VISIBLE_CARDS = 8;

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
          const cards = stageCards.slice(0, VISIBLE_CARDS);
          const more = count - cards.length;
          const href = `/board?stage=${key}`;
          if (data && count === 0) return null;
          return (
            <section key={key} className={`pipeline-stage ${key}`} aria-label={label}>
              <h3>
                <a href={href} onClick={(e) => followLink(e, href)}>
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
              {more > 0 && (
                <a
                  className="pipeline-more mono xs"
                  href={href}
                  onClick={(e) => followLink(e, href)}
                >
                  +{more}
                </a>
              )}
            </section>
          );
        })}
      </div>
    </Panel>
  );
}
