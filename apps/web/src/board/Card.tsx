import {
  type BoardItem,
  CI_PILL,
  type CrewRow,
  type HudColumn,
  type PillSpec,
  type PullRequestView,
  prPill,
  STATUS_OUT_OF_DATE,
} from "@mc/core";
import { type MouseEvent, memo } from "react";
import { seatStatus } from "../crew.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Lamp } from "../hud/Lamp.tsx";
import { Pill, PillButton } from "../hud/Pill.tsx";
import { PrChip, type PrPreview } from "../hud/PrChip.tsx";
import { RepoRef, TicketRef } from "../hud/RepoRef.tsx";
import { agentPath, followLink, navigate, ticketPath, tracePath } from "../router.ts";
import { openItem } from "../shell/overlays.ts";
import {
  type CardSeat,
  type CardYou,
  cardColumn,
  checksText,
  firstBlocker,
  NO_PR_YET,
  NO_REVIEWER,
  NOT_QUEUED,
  ticketRef,
} from "./cards.ts";

/** Tests count card renders through this (#26 A1); null outside tests. */
export const cardRenderProbe: { onRender: ((ref: string) => void) | null } = { onRender: null };

const MAX_LABELS = 3;
const MILESTONE_SPLIT = " — ";
/** Columns where a card should have a PR already. */
const PR_EXPECTED: readonly HudColumn[] = ["In progress", "In review", "Ready for QA"];

/** The card's PR; the card's own header names the repo, so the PR does not. */
function PrLine({ pr, checkPill }: { pr: PullRequestView; checkPill?: PillSpec | null }) {
  // An open, non-draft PR with a live review shows the review state instead of the GitHub one.
  // a crew PR stays a draft until the engine merges it: the review state is the open PR's pill
  const review = pr.state === "open" ? (checkPill ?? null) : null;
  const showState = review !== null || pr.state !== "open" || pr.isDraft || pr.review !== null;
  const ci = pr.ci === null ? null : CI_PILL[pr.ci];
  const state = review ?? prPill(pr);
  const checks = checksText(pr.checks);
  return (
    <>
      <PrChip
        pr={pr}
        bare
        showState={false}
        preview={(pr as PullRequestView & { preview?: PrPreview | null }).preview}
      />
      {ci && <Pill tone={ci.tone}>{ci.label}</Pill>}
      {checks && <span className="xs muted">{checks}</span>}
      {showState && <Pill tone={state.tone}>{state.label}</Pill>}
    </>
  );
}

/** What a card shows, worked out by `Kanban` (`cardProps`) so a card never reads the clock. */
export interface CardProps {
  item: BoardItem;
  showRepo: boolean;
  /** The agent whose run is on this ticket. */
  agent: CrewRow | null;
  /** The agent's template, step and try (`cardStep`); null without an agent. */
  step: string | null;
  /** The seat a Ready card is queued for and its place; null when not queued. */
  queued: (CardSeat & { pos: number }) | null;
  /** The seat reviewing the card's PR; null when none is. */
  reviewer: CardSeat | null;
  /** The PR the card shows. */
  pr: PullRequestView | null;
  /** The PR's review state as a pill (`reviewCheckPill`), set by `Kanban`; null or absent without one. */
  checkPill?: PillSpec | null;
  /** Something on this card waits on you. */
  mine: boolean;
  unacked: boolean;
  /** A Done card's outcome. */
  outcome: "Merged" | "Closed";
  /** A Done card's age, already formatted (`today`, `3d ago`, `—`); "" on other cards. */
  when: string;
  /** The issue's open/closed state and the board's Status disagree; null when they agree. */
  statusOutOfDate: string | null;
  /** The card's "You:" chip, from its Needs-you items; null when none. */
  you: CardYou | null;
}

/**
 * Props equal by value: a refetch hands back unchanged rows as new objects, and those must not
 * re-render the card (#26 A1). Values that are the same object skip the comparison.
 */
function sameProps(a: CardProps, b: CardProps): boolean {
  return (Object.keys(a) as (keyof CardProps)[]).every(
    (k) => Object.is(a[k], b[k]) || JSON.stringify(a[k]) === JSON.stringify(b[k]),
  );
}

/**
 * One ticket. Click the card, or Enter or Space on its title link: the agent's page if one is
 * working it, else the ticket beside the board.
 */
export const Card = memo(function Card({
  item,
  showRepo,
  agent,
  step,
  queued,
  reviewer,
  pr,
  checkPill,
  mine,
  unacked,
  outcome,
  when,
  statusOutOfDate,
  you,
}: CardProps) {
  cardRenderProbe.onRender?.(ticketRef(item));
  const col = cardColumn(item);
  const worked = !mine && (agent?.hudState === "running" || reviewer?.hudState === "running");
  const blocker = col === "Done" ? null : firstBlocker(item);
  const to = agent ? agentPath(agent.id) : ticketPath(item.repoId, item.issueNumber);
  const trace = agent?.loop && agent.run ? tracePath(agent.id, agent.run.id) : null;
  const go = () => navigate(to);
  // The title is the link that opens the card (its ::after covers the card); a click on the rest
  // of the card is a mouse shortcut to it. A link inside the card goes elsewhere (GitHub), and
  // must not also open the card.
  const click = (e: MouseEvent) => {
    if (!(e.target as Element).closest("a")) go();
  };
  const overlay = [
    agent && (
      <span key="agent" className="row">
        <AgentTag id={agent.id} index={agent.index} sm />
        <span title={seatStatus(agent).reason ?? seatStatus(agent).label}>
          <Pill tone={seatStatus(agent).tone}>{seatStatus(agent).label}</Pill>
        </span>
        {step && <span className="xs">{step}</span>}
        {trace && (
          <a className="xs" href={trace} onClick={(e) => followLink(e, trace)}>
            Trace
          </a>
        )}
      </span>
    ),
    !agent &&
      col === "Ready" &&
      (queued ? (
        <span key="queue" className="row">
          <span className="xs">Next for</span>
          <AgentTag id={queued.id} index={queued.index} sm />
          <span className="xs muted">{`· #${queued.pos} in its queue`}</span>
        </span>
      ) : (
        <span key="un" className="xs muted">
          {NOT_QUEUED}
        </span>
      )),
    col !== "Done" &&
      (reviewer ? (
        <span key="rev" className="row">
          <span className="xs">Reviewing:</span>
          <a href={agentPath(reviewer.id)} onClick={(e) => followLink(e, agentPath(reviewer.id))}>
            <AgentTag id={reviewer.id} index={reviewer.index} sm />
          </a>
          {reviewer.status && (
            <span title={reviewer.status.reason ?? reviewer.status.label}>
              <Pill tone={reviewer.status.tone}>{reviewer.status.label}</Pill>
            </span>
          )}
        </span>
      ) : (
        // the review-state pill says who is checking or what the PR waits on; without one, the line does
        col === "In review" &&
        !checkPill && (
          <span key="rev" className="xs muted">
            {NO_REVIEWER}
          </span>
        )
      )),
    col !== "Done" &&
      (pr ? (
        <PrLine key="pr" pr={pr} checkPill={checkPill} />
      ) : (
        PR_EXPECTED.includes(col) && (
          <span key="nopr" className="xs muted">
            {NO_PR_YET}
          </span>
        )
      )),
    col === "Done" && (
      <span key="done" className="row">
        <Pill tone={outcome === "Merged" ? "ok" : "plain"}>{outcome}</Pill>
        <span className="xs muted">
          {when}
          {pr && (
            <>
              {" · "}
              <RepoRef repoId={pr.repoId} number={pr.number} kind="pr" bare url={pr.url} />
            </>
          )}
        </span>
      </span>
    ),
    you && (
      <PillButton
        key="you"
        tone="warn"
        className="kyou"
        title={you.title}
        aria-label={`${you.text}${you.more > 0 ? `, and ${you.more} more` : ""}. Opens its brief.`}
        onClick={(e) => {
          // the card's own click would open the ticket instead
          e.stopPropagation();
          openItem(you.key);
        }}
      >
        {you.text}
        {you.more > 0 && <span className="kyou-more">{` +${you.more}`}</span>}
      </PillButton>
    ),
    statusOutOfDate && (
      <span key="stale" className="xs warn-t" title={statusOutOfDate}>
        {STATUS_OUT_OF_DATE}
      </span>
    ),
    blocker && (
      <span key="blocked" className="xs warn-t">
        Blocked: <TicketRef ticket={blocker} bare={!showRepo} />
      </span>
    ),
  ].filter(Boolean);
  const title = mine ? "Needs you" : worked ? "Being worked on or looked at now" : undefined;
  return (
    // The card holds links (GitHub refs), so it is not a button: its title is the link a keyboard
    // or screen reader uses (Enter), and a click anywhere else on the card is a mouse shortcut to it.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the title link is the keyboard route
    // biome-ignore lint/a11y/noStaticElementInteractions: as above; the card is a container
    <div
      className={`kcard${unacked ? " pulse-warn" : worked ? " pulse-ok" : ""}`}
      title={title}
      data-card={ticketRef(item)}
      onClick={click}
    >
      <div className="kref">
        {mine && <Lamp kind="warn" pulse={unacked} label="Needs you" />}
        {worked && <Lamp kind="ok" pulse label="Being worked on" />}
        <RepoRef repoId={item.repoId} number={item.issueNumber} bare={!showRepo} url={item.url} />
        {item.priority && <span className="p">{item.priority}</span>}
        {item.size && <span>{item.size}</span>}
        <span className="spacer" />
        {item.milestone && (
          <span className="ellip" style={{ maxWidth: 120 }} title={item.milestone}>
            {item.milestone.split(MILESTONE_SPLIT)[0]}
          </span>
        )}
      </div>
      <a
        className="ktitle"
        title={item.title}
        href={to}
        onClick={(e) => followLink(e, to)}
        onKeyDown={(e) => {
          // a link takes Enter natively; Space is the button habit, and must not scroll the board.
          // A modified or held Space is the browser's (or the OS's) own.
          if (e.key === " " && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat) {
            e.preventDefault();
            go();
          }
        }}
      >
        {item.title}
      </a>
      {item.labels.length > 0 && (
        <div className="labels">
          {item.labels.slice(0, MAX_LABELS).map((l) => (
            <span key={l} className="lb" title={l}>
              {l}
            </span>
          ))}
          {item.labels.length > MAX_LABELS && (
            <span className="lb" title={item.labels.join(", ")}>
              +{item.labels.length - MAX_LABELS}
            </span>
          )}
        </div>
      )}
      {overlay.length > 0 && <div className="overlay">{overlay}</div>}
    </div>
  );
}, sameProps);
