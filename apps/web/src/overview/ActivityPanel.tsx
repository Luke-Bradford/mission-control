import {
  type ActivityEvent,
  type ActivityRow,
  type AttentionItem,
  type ConfigView,
  type Crew,
  HUD_STATE_LABEL,
  SEAT_TURN_END_TEXT,
  SEAT_TURN_START_TEXT,
} from "@mc/core";
import { useLayoutEffect, useRef, useState } from "react";
import { needsYouItems } from "../attention.ts";
import { useNow, useTz } from "../clock.ts";
import { CommsEnd, isComms, MentionText } from "../comms/messages.tsx";
import { Expandable } from "../components/Expandable.tsx";
import { MarkdownInline } from "../components/Markdown.tsx";
import { activityKey, compareActivity, RESOURCES, useResource } from "../data.ts";
import { hhmm, rel } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { PrChip } from "../hud/PrChip.tsx";
import { parseTicket, RepoRef, TicketRef } from "../hud/RepoRef.tsx";
import { Seg } from "../hud/Seg.tsx";
import { agentPath, commsAgentPath, commsFlightPath, followLink, itemPath } from "../router.ts";
import { useSessionScope } from "../shell/session.ts";
import { logLine } from "./logLine.ts";

type LogRow = ActivityRow & { attentionKey?: string; escalationRef?: string | null };

type Filter = "steps" | "comms" | "all" | "reviews" | "merges" | "guard" | "needs";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "steps", label: "Steps" },
  { value: "reviews", label: "Reviews" },
  { value: "merges", label: "Merges" },
  { value: "guard", label: "Guard" },
  { value: "needs", label: "Needs you" },
  { value: "comms", label: "Messages" },
];
const SUB: Record<Filter, string> = {
  reviews: "reviews and pull requests",
  merges: "merge activity",
  guard: "guard activity",
  needs: "open items needing you",
  steps: "high-level steps from every agent",
  comms: "what agents said to each other",
  all: "every event",
};
const SHOWN = 120;
const FILTER_KEY = "overview.live-log.filter";
function rememberedFilter(): Filter {
  try {
    const value = localStorage.getItem(FILTER_KEY);
    return FILTERS.find((f) => f.value === value)?.value ?? "steps";
  } catch {
    return "steps";
  }
}

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
  attentionKey,
}: {
  event: ActivityEvent;
  prRepoId: string | null;
  split: [string, string] | null;
  red: boolean;
  attentionKey?: string;
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
      ) : attentionKey && !e.ref ? (
        <a
          href={e.url ?? itemPath(attentionKey)}
          target={e.url ? "_blank" : undefined}
          rel={e.url ? "noreferrer" : undefined}
        >
          {e.text}
        </a>
      ) : (
        <MarkdownInline text={e.text} />
      )}
    </span>
  );
}

/** What happened across the crew (catalogue 2.1.3), newest first, from runs, escalations and sources. */
export function ActivityPanel() {
  const events = useResource<ActivityRow[]>(RESOURCES.activity);
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const attention = useResource<AttentionItem[]>(RESOURCES.attention);
  const tz = useTz();
  const now = useNow();
  const { session, inView, inRepo } = useSessionScope();
  const [filter, setFilter] = useState<Filter>(rememberedFilter);
  const [frozen, setFrozen] = useState<LogRow[] | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const [reading, setReading] = useState<{ session: string; rows: LogRow[] } | null>(null);

  const agents = new Map(crew?.rows.map((r) => [r.id, r]));
  const repoIds = new Set([
    ...(crew?.rows.map((r) => r.repoId) ?? []),
    ...(config?.repos.map((r) => r.id) ?? []),
  ]);
  /** The repo an event belongs to: its agent's, itself, or one named in a collector (`github:shop-app`). */
  const repoOf = (who: string): string | null =>
    agents.get(who)?.repoId ?? [who, ...who.split(":")].find((p) => repoIds.has(p)) ?? null;

  // The Needs-you set, as the header counts it: one row per item, and no session filter below.
  const needs: LogRow[] = needsYouItems(attention.data).map((i) => ({
    attentionKey: i.key,
    escalationRef: i.escalationId ? i.ticket : null,
    at: i.messageAt ?? i.at,
    who: i.agentId ?? i.repoId ?? "Needs you",
    kind: "escalation",
    text: i.text,
    ref: i.ticket,
    url: i.url,
    status: null,
    prs: [],
    summary: null,
  }));
  const escalationRefs = new Set(
    (events.data ?? []).filter((e) => e.kind === "escalation").map((e) => e.ref),
  );
  const usesAttention = filter === "needs" || filter === "all";
  const resources = [
    ...(filter === "needs" ? [] : [{ name: "activity", ...events }]),
    ...(usesAttention ? [{ name: "attention", ...attention }] : []),
  ];
  const source: LogRow[] =
    frozen ??
    (filter === "needs"
      ? needs
      : filter === "all"
        ? [
            ...(events.data ?? []),
            ...needs.filter((i) => !i.escalationRef || !escalationRefs.has(i.escalationRef)),
          ]
        : (events.data ?? []));
  const rows = source
    .filter((e) => {
      if (filter === "all" || filter === "needs") return true;
      if (filter === "guard") return e.kind === "guard";
      if (filter === "reviews")
        return (
          e.kind === "pr-opened" ||
          e.kind === "pr-merged" ||
          (e.kind === "loop" && /review/i.test(e.text))
        );
      if (filter === "merges")
        return (
          e.kind === "pr-merged" ||
          (e.kind === "loop" &&
            /^(?:merged?\b|marked (?:PR #\d+|the PR) ready|closed #\d+|deleted origin's |deleted the local branch |could not delete the local branch |(?:mark ready|close the issue|delete the remote branch) failed:)/i.test(
              e.text,
            ))
        );
      if (filter === "comms") return isComms(e);
      return (
        !isComms(e) &&
        !(e.kind === "state" && (e.text === SEAT_TURN_START_TEXT || e.text === SEAT_TURN_END_TEXT))
      );
    })
    .filter((e) => {
      // Needs you is the operator's whole inbox: the session filter never hides it.
      if (e.attentionKey !== undefined) return true;
      if (isComms(e)) {
        const ends = [e.who, e.to].flatMap((id) => agents.get(id) ?? []);
        return ends.length === 0 || ends.some(inView);
      }
      const agent = agents.get(e.who);
      if (agent) return inView(agent);
      const repo = repoOf(e.who);
      return repo === null || inRepo(repo);
    })
    .sort(compareActivity)
    .slice(0, SHOWN);
  const held = reading?.session === session ? reading.rows : null;
  const rowKey = (row: LogRow) => row.attentionKey ?? activityKey(row);
  const current = new Map<string, LogRow[]>();
  for (const row of rows) {
    const key = rowKey(row);
    const group = current.get(key) ?? [];
    group.push(row);
    current.set(key, group);
  }
  // Hold membership and order while reading, but keep existing rows current.
  const displayed = held?.map((row) => current.get(rowKey(row))?.shift() ?? row) ?? rows;
  const heldCounts = new Map<string, number>();
  for (const row of displayed) {
    const key = rowKey(row);
    heldCounts.set(key, (heldCounts.get(key) ?? 0) + 1);
  }
  const newCount = held
    ? rows.filter((row) => {
        const key = rowKey(row);
        const count = heldCounts.get(key) ?? 0;
        heldCounts.set(key, Math.max(0, count - 1));
        return count === 0;
      }).length
    : 0;
  // Number identical source rows so both remain visible.
  const seen = new Map<string, number>();
  const keyed = displayed.map((e) => {
    const base = e.attentionKey ?? activityKey(e);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { e, key: `${base}#${n}` };
  });

  useLayoutEffect(() => {
    if (!held && list.current) list.current.scrollTop = 0;
  }, [held]);

  return (
    <Panel
      id="actP"
      title="Live log"
      sub={SUB[filter]}
      actions={
        <>
          <button
            type="button"
            className="sm ghost"
            disabled={newCount === 0}
            aria-hidden={newCount === 0}
            style={{ visibility: newCount > 0 ? "visible" : "hidden", width: "9ch" }}
            onClick={() => setReading(null)}
          >
            {newCount} new
          </button>
          <Seg
            label="Activity filter"
            options={FILTERS}
            value={filter}
            onChange={(value) => {
              setFilter(value);
              setFrozen(null);
              setReading(null);
              try {
                localStorage.setItem(FILTER_KEY, value);
              } catch {
                /* Storage can be unavailable. */
              }
            }}
          />
          <button
            type="button"
            className="sm ghost"
            onClick={() => setFrozen(frozen ? null : source)}
          >
            {frozen ? "Resume" : "Pause"}
          </button>
        </>
      }
    >
      <div
        className="scroll"
        id="actList"
        ref={list}
        aria-live="off"
        style={{ overflowAnchor: "none" }}
        onScroll={() => {
          if ((list.current?.scrollTop ?? 0) > 0) {
            if (!held) setReading({ session, rows });
          } else setReading(null);
        }}
      >
        {keyed.map(({ e, key }) => {
          if (isComms(e)) {
            const preview = logLine(e.text, "comms");
            // The conversation is with the crew agent at either end; FLIGHT's thread otherwise.
            const partner = [e.who, e.to].find((id) => agents.has(id));
            const readPath = partner ? commsAgentPath(partner) : commsFlightPath();
            return (
              <div key={key} className="arow k-comms">
                <span className="t num" title={tz ? rel(e.at, now, tz) : undefined}>
                  {tz ? hhmm(e.at, tz) : "—"}
                </span>
                <span className="g">{GLYPH.comms}</span>
                <span className="log-who ellip">
                  <CommsEnd id={e.who} />
                </span>
                <span className="txt log-line">
                  <span className="muted">→</span> <CommsEnd id={e.to} />{" "}
                  <MentionText text={preview.text} />
                </span>
                {e.ref || preview.cut ? (
                  <span className="arefs">
                    {e.ref && <TicketRef ticket={e.ref} url={null} />}
                    {preview.cut && (
                      <a
                        className="log-read"
                        href={readPath}
                        onClick={(event) => followLink(event, readPath)}
                      >
                        read ›
                      </a>
                    )}
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
              <span className="t num" title={tz ? rel(e.at, now, tz) : undefined}>
                {tz ? hhmm(e.at, tz) : "—"}
              </span>
              <span className={red ? "g crit-t" : "g"}>{GLYPH[e.kind] ?? FALLBACK_GLYPH}</span>
              <span className="log-who ellip" title={e.who}>
                {e.runId ? (
                  <a
                    href={`${agentPath(e.who)}?run=${encodeURIComponent(e.runId)}`}
                    onClick={(event) =>
                      followLink(
                        event,
                        `${agentPath(e.who)}?run=${encodeURIComponent(e.runId ?? "")}`,
                      )
                    }
                  >
                    {agent ? (
                      <AgentTag id={agent.id} index={agent.index} sm />
                    ) : (
                      <span className="muted">{e.who}</span>
                    )}
                  </a>
                ) : agent ? (
                  <AgentTag id={agent.id} index={agent.index} sm />
                ) : (
                  <span className="muted">{e.who}</span>
                )}
              </span>
              <Expandable lines={1}>
                <span className="txt">
                  <ActivityText
                    event={{ ...e, text: logLine(e.text, "step").text }}
                    prRepoId={prRepo(e, config, repoIds, repoOf(e.who))}
                    split={split}
                    red={red}
                    attentionKey={e.attentionKey}
                  />
                </span>
              </Expandable>
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
        {rows.length === 0 && resources.every((r) => r.data !== undefined && !r.error) && (
          <div className="pb muted">No events yet.</div>
        )}
        {resources.map((r) =>
          r.error ? (
            <div key={r.name} className="pb crit-t">
              {r.data
                ? `Could not refresh ${r.name}. Showing last known items.`
                : `Could not load ${r.name}.`}
            </div>
          ) : r.data === undefined ? (
            <div key={r.name} className="pb muted">{`Loading ${r.name}…`}</div>
          ) : null,
        )}
      </div>
    </Panel>
  );
}
