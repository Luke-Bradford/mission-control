import {
  type ActivityEvent,
  type ConfigView,
  type Crew,
  ENGINE_NOT_RUNNING,
  HUD_STATE_LABEL,
} from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { useTz } from "../clock.ts";
import { MarkdownInline } from "../components/Markdown.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { hhmm } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { PrChip } from "../hud/PrChip.tsx";
import { parseTicket, RepoRef, TicketRef } from "../hud/RepoRef.tsx";
import { Seg } from "../hud/Seg.tsx";
import { inSession, useSession } from "../shell/session.ts";

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

const GLYPH: Record<ActivityEvent["kind"], string> = {
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
};
const KIND_CLASS: Record<ActivityEvent["kind"], string> = {
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
  const events = useResource<ActivityEvent[]>(RESOURCES.activity);
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const tz = useTz();
  const [session] = useSession();
  const [filter, setFilter] = useState<Filter>("steps");
  const [frozen, setFrozen] = useState<ActivityEvent[] | null>(null);
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
  const rows = (filter === "comms" ? [] : source)
    .filter((e) => {
      const repo = repoOf(e.who);
      return repo === null || inSession(session, repo);
    })
    .slice(0, SHOWN)
    .reverse();
  // Events have no id: key by content, and number repeats so twins never share a key.
  const seen = new Map<string, number>();
  const keyed = rows.map((e) => {
    const base = `${e.at}:${e.who}:${e.kind}:${e.text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { e, key: `${base}#${n}` };
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the newest row when the list changes
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length, filter]);

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
          const agent = agents.get(e.who);
          const failed = e.kind === "run-end" && e.status === "failed";
          const intoRed = e.kind === "state" && RED_ARROWS.some((a) => e.text.includes(a));
          const boardFailed = e.kind === "board" && e.text.includes(BOARD_FAILED);
          const red = failed || e.kind === "collector" || intoRed || boardFailed;
          const split = splitRef(e.text, e.ref);
          return (
            <div key={key} className={`arow ${KIND_CLASS[e.kind]}`}>
              <span className="t num">{tz ? hhmm(e.at, tz) : "—"}</span>
              <span className={red ? "g crit-t" : "g"}>{GLYPH[e.kind]}</span>
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
        {filter === "comms" && <div className="pb muted">{ENGINE_NOT_RUNNING}</div>}
        {filter !== "comms" && rows.length === 0 && !events.error && events.data && (
          <div className="pb muted">No events yet.</div>
        )}
        {events.error && !events.data && <div className="pb crit-t">Could not load activity.</div>}
      </div>
    </Panel>
  );
}
