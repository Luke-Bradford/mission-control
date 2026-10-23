import {
  type ActivityEvent,
  type ActivityRow,
  type ConfigView,
  type Crew,
  HUD_STATE_LABEL,
  SEAT_TURN_END_TEXT,
  SEAT_TURN_START_TEXT,
} from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { useTz } from "../clock.ts";
import { CommsEnd, isComms, MentionText } from "../comms/messages.tsx";
import { MarkdownInline } from "../components/Markdown.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { hhmm } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { PrChip } from "../hud/PrChip.tsx";
import { parseTicket, RepoRef, TicketRef } from "../hud/RepoRef.tsx";
import { Seg } from "../hud/Seg.tsx";
import { useSessionScope } from "../shell/session.ts";

type Filter = "steps" | "comms" | "all";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "steps", label: "Steps" },
  { value: "comms", label: "Messages" },
  { value: "all", label: "Everything" },
];
const SUB: Record<Filter, string> = {
  steps: "high-level steps from every agent",
  comms: "what agents said to each other",
  all: "every event",
};
const SHOWN = 120;

const FALLBACK_GLYPH = "◆";
const FALLBACK_CLASS = "k-step";
// Keyed by string, not ActivityKind: a kind the server sends before this map knows it falls back.
const GLYPH: Record<string, string> = {
  "run-start": "→",
  "run-end": "◆",
  escalation: "◆",
  collector: "◆",
  state: "◆",
  "pr-opened": "⇡",
  "pr-merged": "⇡",
  board: "▤",
  loop: "↻",
  push: "⇡",
  check: "✓",
  commit: "●",
  lock: "⊟",
  guard: "⊘",
  comms: "›",
};
const KIND_CLASS: Record<string, string> = {
  "run-start": "k-step",
  "run-end": "k-state",
  escalation: "k-state",
  collector: "k-state",
  state: "k-state",
  "pr-opened": "k-step",
  "pr-merged": "k-step",
  board: "k-step",
  loop: "k-step",
  push: "k-step",
  check: "k-check",
  commit: "k-commit",
  lock: "k-lock",
  guard: "k-guard",
  comms: "k-comms",
};
/** A state change into one of these is red (the text reads `{From} → {To}`). */
const RED_ARROWS = (["error", "stalled"] as const).map((s) => `→ ${HUD_STATE_LABEL[s]}`);

/** A board event whose text holds this is a move the server could not make. */
const BOARD_FAILED = " failed: ";

/** The server words a PR event `PR #n opened: …` or `PR #n merged: …`. */
const PR_EVENT = /^PR #(\d+)( .*)$/s;

/**
 * A run event's text around its ticket: the server writes `started on {ref}` and
 * `{status} · {ref} · …`, so the first `{ref}` after ` on ` or ` · ` is the ticket. Null when the
 * text does not carry it.
 */
export function splitRef(text: string, ref: string | null): [string, string] | null {
  if (!ref) return null;
  for (let from = text.indexOf(ref); from >= 0; from = text.indexOf(ref, from + 1)) {
    const end = from + ref.length;
    if (/ (?:on|·) $/.test(text.slice(0, from)) && (end === text.length || text[end] === " ")) {
      return [text.slice(0, from), text.slice(end)];
    }
  }
  return null;
}

/** `owner/name` of a github.com pull request URL; null for any other URL. */
function pullRepo(url: string | null): string | null {
  const m = url ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url) : null;
  return m?.[1] ?? null;
}

/**
 * The repo a PR event is about. A run can publish in another repo than its agent's, so the agent
 * comes last: the event's ticket, else the repo whose GitHub name the PR's URL carries.
 */
function prRepo(
  e: ActivityEvent,
  config: ConfigView | undefined,
  repoIds: Set<string>,
  viaWho: string | null,
): string | null {
  const ticketRepo = e.ref ? parseTicket(e.ref)?.repoId : undefined;
  if (ticketRepo && repoIds.has(ticketRepo)) return ticketRepo;
  const github = pullRepo(e.url);
  const byUrl = github ? config?.repos.find((r) => r.github === github)?.id : undefined;
  return byUrl ?? viaWho;
}

/**
 * An event's text. A PR event's `PR #n` and a run event's ticket become linked chips; the PR
 * link is built from the repo, never from the event's URL, which is not a reason to link a ticket.
 */
function ActivityText({
  event: e,
  prRepoId,
  split,
  red,
}: {
  event: ActivityEvent;
  prRepoId: string | null;
  split: [string, string] | null;
  red: boolean;
}) {
  const pr = e.kind === "pr-opened" || e.kind === "pr-merged" ? PR_EVENT.exec(e.text) : null;
  return (
    <span className={red ? "crit-t" : undefined}>
      {pr && prRepoId ? (
        <>
          <RepoRef repoId={prRepoId} number={Number(pr[1])} kind="pr" bare={e.who === prRepoId} />
          {pr[2]}
        </>
      ) : split && e.ref ? (
        <>
          {split[0]}
          <TicketRef ticket={e.ref} url={e.kind === "escalation" ? e.url : null} />
          {split[1]}
        </>
      ) : (
        <MarkdownInline text={e.text} />
      )}
    </span>
  );
}

/** What happened across the crew (catalogue 2.1.3), oldest first, from runs, escalations and sources. */
export function ActivityPanel() {
  const events = useResource<ActivityRow[]>(RESOURCES.activity);
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const tz = useTz();
  const { inView, inRepo } = useSessionScope();
  const [filter, setFilter] = useState<Filter>("steps");
  const [frozen, setFrozen] = useState<ActivityRow[] | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const agents = new Map(crew?.rows.map((r) => [r.id, r]));
  const repoIds = new Set([
    ...(crew?.rows.map((r) => r.repoId) ?? []),
    ...(config?.repos.map((r) => r.id) ?? []),
  ]);
  /** The repo an event belongs to: its agent's, itself, or one named in a collector (`github:shop-app`). */
  const repoOf = (who: string): string | null =>
    agents.get(who)?.repoId ?? [who, ...who.split(":")].find((p) => repoIds.has(p)) ?? null;

  const source = frozen ?? events.data ?? [];
  const rows = source
    .filter((e) => {
      if (filter === "all") return true;
      if (filter === "comms") return isComms(e);
      return (
        !isComms(e) &&
        !(e.kind === "state" && (e.text === SEAT_TURN_START_TEXT || e.text === SEAT_TURN_END_TEXT))
      );
    })
    .filter((e) => {
      if (isComms(e)) {
        const ends = [e.who, e.to].flatMap((id) => agents.get(id) ?? []);
        return ends.length === 0 || ends.some(inView);
      }
      const agent = agents.get(e.who);
      if (agent) return inView(agent);
      const repo = repoOf(e.who);
      return repo === null || inRepo(repo);
    })
    .slice(0, SHOWN)
    .reverse();
  // Events have no id: key by content, and number repeats so twins never share a key.
  const seen = new Map<string, number>();
  const keyed = rows.map((e) => {
    const base = `${e.at}:${e.who}:${e.kind}:${isComms(e) ? `${e.to}:` : ""}${e.text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { e, key: `${base}#${n}` };
  });

  const newest = keyed.at(-1)?.key ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the newest row when it changes
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [newest, filter]);

  return (
    <Panel
      id="actP"
      title="Activity"
      sub={SUB[filter]}
      actions={
        <>
          <Seg label="Activity filter" options={FILTERS} value={filter} onChange={setFilter} />
          <button
            type="button"
            className="sm ghost"
            onClick={() => setFrozen(frozen ? null : (events.data ?? []))}
          >
            {frozen ? "Resume" : "Pause"}
          </button>
        </>
      }
    >
      <div className="scroll" id="actList" ref={list}>
        {keyed.map(({ e, key }) => {
          if (isComms(e)) {
            return (
              <div key={key} className="arow k-comms">
                <span className="t num">{tz ? hhmm(e.at, tz) : "—"}</span>
                <span className="g">{GLYPH.comms}</span>
                <span className="txt">
                  <CommsEnd id={e.who} /> <span className="muted">→</span> <CommsEnd id={e.to} />{" "}
                  <MentionText text={e.text} />
                </span>
                {e.ref ? (
                  <span className="arefs">
                    <TicketRef ticket={e.ref} url={null} />
                  </span>
                ) : (
                  <span />
                )}
              </div>
            );
          }
          const agent = agents.get(e.who);
          const failed = e.kind === "run-end" && e.status === "failed";
          const intoRed = e.kind === "state" && RED_ARROWS.some((a) => e.text.includes(a));
          const boardFailed = e.kind === "board" && e.text.includes(BOARD_FAILED);
          const red = failed || e.kind === "collector" || intoRed || boardFailed;
          const split = splitRef(e.text, e.ref);
          return (
            <div key={key} className={`arow ${KIND_CLASS[e.kind] ?? FALLBACK_CLASS}`}>
              <span className="t num">{tz ? hhmm(e.at, tz) : "—"}</span>
              <span className={red ? "g crit-t" : "g"}>{GLYPH[e.kind] ?? FALLBACK_GLYPH}</span>
              <span className="txt">
                {agent ? (
                  <AgentTag id={agent.id} index={agent.index} sm />
                ) : (
                  <span className="muted">{e.who}</span>
                )}{" "}
                <ActivityText
                  event={e}
                  prRepoId={prRepo(e, config, repoIds, repoOf(e.who))}
                  split={split}
                  red={red}
                />
              </span>
              {e.ref || e.prs.length > 0 ? (
                <span className="arefs">
                  {e.ref && !split && (
                    <TicketRef ticket={e.ref} url={e.kind === "escalation" ? e.url : null} />
                  )}
                  {e.prs.map((pr) => (
                    <PrChip key={`${pr.repoId}#${pr.number}`} pr={pr} />
                  ))}
                </span>
              ) : (
                <span />
              )}
            </div>
          );
        })}
        {rows.length === 0 && !events.error && events.data && (
          <div className="pb muted">No events yet.</div>
        )}
        {events.error && !events.data && <div className="pb crit-t">Could not load activity.</div>}
      </div>
    </Panel>
  );
}
