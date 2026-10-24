import type { OverviewSummary, PipelineStage } from "@mc/core";
import { useNow } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { followLink, ticketPath } from "../router.ts";
import { useSession } from "../shell/session.ts";
import { age } from "./agentActivity.ts";

export const PIPELINE_STAGES = {
  ready: "Ready",
  building: "Building",
  checks: "Checks",
  review: "Review",
  merging: "Merging",
  merged: "Merged today",
} satisfies Record<PipelineStage["stage"], string>;

const VISIBLE_CARDS = 3;

export function PipelinePanel() {
  const [session] = useSession();
  const { data, error } = useResource<OverviewSummary>(RESOURCES.overview(session));
  const now = useNow();
  return (
    <Panel id="pipelineP" title="Pipeline">
      {error && <p className="pb crit-t">{error.message}</p>}
      {!data && !error && <p className="pb muted">Loading…</p>}
      {data && (
        <div className="pipeline-grid pb scroll">
          {Object.entries(PIPELINE_STAGES).map(([key, label]) => {
            const stage = data.pipeline?.find((s) => s.stage === key);
            const cards = stage?.cards?.slice(0, VISIBLE_CARDS) ?? [];
            const more = (stage?.count ?? 0) - cards.length;
            const href = `/board?stage=${key}`;
            return (
              <section key={key} className={`pipeline-stage ${key}`} aria-label={label}>
                <h3>
                  {label}
                  <span className="num">{stage?.count ?? 0}</span>
                  <span className="xs muted num pipeline-oldest">
                    oldest {stage?.oldestAt == null ? "—" : age(stage.oldestAt, now)}
                  </span>
                </h3>
                {cards.map((card) => {
                  const to = ticketPath(card.repoId, card.ticket);
                  return (
                    <a
                      key={`${key}:${card.repoId}#${card.ticket}:${card.pr}`}
                      className="pipeline-card"
                      title={`${card.who ?? (key === "merged" ? "merged" : "waiting on you")} · ${age(card.since, now)}`}
                      href={to}
                      onClick={(e) => followLink(e, to)}
                    >
                      <span
                        className="pipeline-title"
                        title={`${card.repoId}#${card.ticket} · ${card.title}`}
                      >
                        #{card.ticket}
                        {card.pr !== null && ` · PR #${card.pr}`} · {card.title}
                      </span>
                      <span className="pipeline-ci">
                        {card.ci?.map((state, i) => (
                          <span
                            // biome-ignore lint/suspicious/noArrayIndexKey: CI states have no check ids; each position is a dot.
                            key={`${i}-${state}`}
                            role="img"
                            aria-label={`CI ${state}`}
                            className={`pipeline-dot ${state}`}
                          />
                        ))}
                      </span>
                    </a>
                  );
                })}
                {more > 0 && (
                  <a
                    className="pipeline-more mono xs"
                    href={href}
                    onClick={(e) => followLink(e, href)}
                  >
                    +{more} more
                  </a>
                )}
              </section>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
