import type { Crew, OverviewSummary, PipelineCard, PipelineStage } from "@mc/core";
import { type CSSProperties, useRef } from "react";
import { cardAgent, reworkLabel } from "../board/cards.ts";
import { useNow } from "../clock.ts";
import { callSign } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { elapsed, percent, plural } from "../fmt.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { metricTitle, useMetrics } from "../metrics.ts";
import { followLink, PAGE_PATHS, ticketPath } from "../router.ts";
import { useSession } from "../shell/session.ts";
import { useFittingCards } from "./useFittingCards.ts";

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

/** More checks than this show as a count, not a mark each. */
const CI_MARKS_MAX = 4;

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
  const lanes = boardLanes(data?.pipeline ?? []);
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
          · CI{" "}
          <b title="CI runs that passed in the last 24 hours, of those that finished">
            {percent(ci?.pct)}
          </b>
          {ci?.runs ? ` of ${plural(ci.runs, "run")} in 24h` : ""}
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
      {metrics.error && (
        <p role="status" className="pb s warn-t">
          {metrics.view
            ? "Registry figures: refresh failed, showing stale values."
            : `Registry figures could not load: ${metrics.error.message}`}
        </p>
      )}
      <div
        className="board-stages"
        aria-busy={!data && !error}
        style={
          {
            "--board-cols": boardTracks(lanes, BOARD_COLUMNS, Boolean(data)),
            "--board-cols-wide": boardTracks(lanes, BOARD_COLUMNS_WIDE, Boolean(data)),
            "--board-rows-wide": boardRowsWide(lanes, Boolean(data)),
          } as CSSProperties
        }
      >
        {lanes.map((lane) => (
          <BoardStage key={lane.key} lane={lane} loaded={Boolean(data)} now={now} crew={crew} />
        ))}
      </div>
    </Panel>
  );
}

/** A PR's checks as marks: shape as well as colour, with the count in words for a reader. */
function CiMarks({ ci }: { ci: PipelineCard["ci"] }) {
  const passed = ci.filter((check) => check === "pass").length;
  const failed = ci.filter((check) => check === "fail").length;
  const label = `CI: ${passed} of ${ci.length} passed${failed ? `, ${failed} failed` : ""}`;
  // Many checks would wrap the card's meta line, so past a few they read as a count.
  if (ci.length > CI_MARKS_MAX)
    return (
      <span
        className={`ci-count${failed ? " crit-t" : ""}`}
        role="img"
        aria-label={label}
        title={label}
      >
        {failed ? "✗ " : ""}CI {passed}/{ci.length}
      </span>
    );
  return (
    <span className="ci-marks" role="img" aria-label={label} title={label}>
      {ci.map((check, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: checks have no identity here, only their result
        <i key={i} className={`ci-${check}`} />
      ))}
    </span>
  );
}

/** One Board lane: its stages' cards, counts and oldest ticket, after a merged ticket has left review. */
export interface BoardLane {
  key: PipelineLane;
  label: string;
  cards: PipelineCard[];
  count: number;
  oldest: number;
}

/**
 * The lanes from the server's stages. A merged pull request takes its own card out of In review and
 * Merging, whatever the ticket's state: a card leaves when its pull request is in Done, or, with no
 * pull request on the card, when its ticket is. A new open pull request on a ticket whose earlier
 * one merged stays in review.
 */
export function boardLanes(pipeline: readonly PipelineStage[]): BoardLane[] {
  const ref = (card: { repoId: string; ticket: number }) => `${card.repoId}#${card.ticket}`;
  const doneCards = pipeline
    .filter((stage) => stage.stage === "merged")
    .flatMap((stage) => stage.cards ?? []);
  const mergedPrs = new Set(
    doneCards.flatMap((card) => (card.pr === null ? [] : [`${card.repoId}#${card.pr}`])),
  );
  const doneTickets = new Set(doneCards.map(ref));
  const merged = (card: PipelineCard) =>
    card.pr !== null ? mergedPrs.has(`${card.repoId}#${card.pr}`) : doneTickets.has(ref(card));
  return (Object.entries(PIPELINE_STAGES) as [PipelineLane, string][]).map(([key, label]) => {
    const stages = pipeline.filter((stage) => PIPELINE_LANE_STAGES[key].includes(stage.stage));
    const all = stages.flatMap((stage) => stage.cards ?? []);
    const cards = key === "review" || key === "merging" ? all.filter((c) => !merged(c)) : all;
    const total = stages.reduce((sum, stage) => sum + stage.count, 0);
    const oldest = Math.min(
      ...stages.flatMap((stage) => (stage.oldestAt === null ? [] : [stage.oldestAt])),
    );
    return { key, label, cards, count: total - (all.length - cards.length), oldest };
  });
}

/** The columns at each width: the five lanes, or four with Merging under In review. */
const BOARD_COLUMNS: readonly (readonly PipelineLane[])[] = [
  ["ready"],
  ["progress"],
  ["review"],
  ["merging"],
  ["merged"],
];
const BOARD_COLUMNS_WIDE: readonly (readonly PipelineLane[])[] = [
  ["ready"],
  ["progress"],
  ["review", "merging"],
  ["merged"],
];

/**
 * Grid tracks for a column set: a column with nothing in it is as wide as its head, and the busy
 * ones share the rest. While nothing has loaded every column is equal.
 */
export function boardTracks(
  lanes: readonly BoardLane[],
  columns: readonly (readonly PipelineLane[])[],
  loaded: boolean,
): string {
  return columns
    .map((keys) =>
      loaded && keys.every((key) => lanes.find((lane) => lane.key === key)?.count === 0)
        ? "auto"
        : "minmax(0, 1fr)",
    )
    .join(" ");
}

/**
 * The wide layout's two rows (In review over Merging): an empty Merging is only its head; a busy one
 * takes a third, so both bodies have a height of their own for the fit to work in.
 */
export function boardRowsWide(lanes: readonly BoardLane[], loaded: boolean): string {
  const merging = lanes.find((lane) => lane.key === "merging");
  return loaded && merging?.count === 0 ? "minmax(0, 1fr) auto" : "minmax(0, 2fr) minmax(0, 1fr)";
}

function BoardStage({
  lane,
  loaded,
  now,
  crew,
}: {
  lane: BoardLane;
  loaded: boolean;
  now: number;
  crew: Crew | undefined;
}) {
  const { key, label, cards, count, oldest } = lane;
  const body = useRef<HTMLDivElement>(null);
  const stageHref = `${PAGE_PATHS.board}?stage=${key}`;
  const empty = loaded && count === 0;
  const cut = count > cards.length;
  const { limit: fitting, measuring } = useFittingCards(
    body,
    cards
      .map((card) => `${card.repoId}#${card.ticket}:${card.pr}:${card.title}:${card.rework?.round}`)
      .join("|"),
    cut,
  );
  const shown = fitting === null ? cards : cards.slice(0, fitting);
  const left = count - shown.length;
  return (
    <section className={`board-stage ${key}${empty ? " empty" : ""}`} aria-label={label}>
      <h3>
        <a href={stageHref} onClick={(e) => followLink(e, stageHref)}>
          {label}
        </a>
        <b className="num">{loaded ? count : DASH}</b>
        {key !== "merged" && Number.isFinite(oldest) && count > 0 && (
          <span className="board-oldest">oldest {elapsed(now - oldest)}</span>
        )}
      </h3>
      {!empty && (
        <div className="board-cards" ref={body}>
          {shown.map((card) => (
            <BoardCard
              key={`${key}:${card.repoId}#${card.ticket}:${card.pr}`}
              card={card}
              lane={key}
              now={now}
              crew={crew}
            />
          ))}
          {measuring && shown.length > 0 && (
            // Stands in for the real link while measuring, so its height is reserved.
            <span className="board-more s measuring" aria-hidden="true">
              +{left} more
            </span>
          )}
          {!measuring && left > 0 && (
            <a
              className="board-more s"
              href={stageHref}
              aria-label={`${left} more on the Board`}
              onClick={(e) => followLink(e, stageHref)}
            >
              +{left} more
            </a>
          )}
        </div>
      )}
    </section>
  );
}

function BoardCard({
  card,
  lane,
  now,
  crew,
}: {
  card: PipelineCard;
  lane: PipelineLane;
  now: number;
  crew: Crew | undefined;
}) {
  const owner = assignee(card.who, crew);
  const href = pipelineCardPath(card);
  const rework =
    card.rework &&
    reworkLabel(card.rework, {
      ready: lane === "ready",
      onTicket:
        cardAgent({ repoId: card.repoId, issueNumber: card.ticket }, crew?.rows ?? [])?.id ===
        card.rework.seat,
      pr: card.pr,
    });
  return (
    <a className="board-card" href={href} onClick={(e) => followLink(e, href)}>
      <span className="board-title" title={card.title}>
        <span className="board-ticket num">#{card.ticket}</span> {cardTitle(card)}
      </span>
      {rework && <span className="board-rework">{rework}</span>}
      <span className="board-meta">
        {owner && !rework?.includes(owner.name) && (
          <span className="pipeline-assignee" title={owner.name}>
            <i style={{ "--c": agentColor(owner.index) } as CSSProperties} aria-hidden="true" />
            <span>{owner.name}</span>
          </span>
        )}
        {card.priority && <b className="board-tag">{card.priority}</b>}
        {card.size && <span className="board-tag">{card.size}</span>}
        {card.pr !== null && !(rework && lane === "ready") && (
          <span className="num">PR {card.pr}</span>
        )}
        {card.ci.length > 0 && <CiMarks ci={card.ci} />}
        <span className="board-age num">{elapsed(now - card.since)}</span>
      </span>
    </a>
  );
}
