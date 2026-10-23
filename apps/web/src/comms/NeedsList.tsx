import {
  ATTENTION_KINDS,
  ATTENTION_LABEL,
  type AttentionItem,
  type CrewRow,
  clockHm,
  FLIGHT_NOT_RUNNING,
  type FlightView,
  GUARD_NONE_TEXT,
  type GuardHitsView,
  guardAckKey,
  guardSummary,
} from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { ackKeys } from "../ack.ts";
import { isOperatorItem, itemOwner, ownerLabel } from "../attention.ts";
import { useSecond, useTz } from "../clock.ts";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { MarkdownInline } from "../components/Markdown.tsx";
import { needsLamp } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { mss } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Lamp } from "../hud/Lamp.tsx";
import { Panel } from "../hud/Panel.tsx";
import { RepoRef } from "../hud/RepoRef.tsx";
import { agentPath, navigate } from "../router.ts";
import { openDockChat, openItem, useFlightUnread } from "../shell/overlays.ts";
import { GUARD_DRAWER_ID } from "../telemetry/guardCopy.ts";
import { type AnswerTarget, answerTarget, sendAnswer } from "./answer.ts";
import { BriefOptions } from "./ItemBrief.tsx";

/** Rows are cut here (catalogue 2.5.1). */
export const NEED_TEXT_MAX = 170;

/** Stalls read from the item's own `at` and `tool` on the 1 s clock; the server text is only "No output". */
export function needText(i: AttentionItem, now: number): string {
  if (i.kind !== "stalled") return i.text;
  return `${mss(now - i.at)} ${i.tool ? `in ${i.tool}` : "without output"}`;
}

/** The server words a PR item `PR #n · You: …`; the number becomes a link to the PR's repo. */
const PR_TEXT = /^PR #(\d+)( · .*)$/s;

function NeedText({ item, now }: { item: AttentionItem; now: number }) {
  const text = needText(item, now);
  const m = item.kind === "pr" && item.repoId !== null ? PR_TEXT.exec(text) : null;
  // inline only, cut after parsing: a row stays one run of text and never ends in half a marker
  if (!m || item.repoId === null) {
    return (
      <span>
        <MarkdownInline text={text} max={NEED_TEXT_MAX} />
      </span>
    );
  }
  return (
    <span>
      <RepoRef repoId={item.repoId} number={Number(m[1])} kind="pr" url={item.url} />
      <MarkdownInline text={m[2] ?? ""} max={NEED_TEXT_MAX - `PR #${m[1]}`.length} />
    </span>
  );
}

/** Kind order (`ATTENTION_KINDS`), then as the server sent them. */
export function sortNeeds(items: AttentionItem[]): AttentionItem[] {
  const rank = (i: AttentionItem) => ATTENTION_KINDS.indexOf(i.kind);
  return [...items].sort((a, b) => rank(a) - rank(b));
}

/** Comms › Needs you (catalogue 2.5.1): the attention list, with Ack and Acknowledge all. */
export function NeedsList({
  items,
  rows,
}: {
  items: AttentionItem[] | undefined;
  rows: CrewRow[];
}) {
  const now = useSecond();
  const replies = useFlightUnread();
  const flightSeat = useResource<FlightView>(RESOURCES.flight).data?.seat ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = sortNeeds((items ?? []).filter(isOperatorItem));
  const handled = sortNeeds((items ?? []).filter((i) => !isOperatorItem(i)));
  const unacked = list.filter((i) => !i.acked).map((i) => i.key);

  const ack = async (keys: string[]) => {
    setBusy(true);
    setError(null);
    setError(await ackKeys(keys));
    setBusy(false);
  };
  const answer = async (target: AnswerTarget, i: AttentionItem, body: string) => {
    setBusy(true);
    setError(null);
    setError(await sendAnswer(target, flightSeat, i, i.text, body));
    setBusy(false);
  };

  return (
    <Panel
      id="cNeedsP"
      title="Needs you"
      sub={
        list.length > 0 ? `${list.length} · ${unacked.length} not acknowledged` : "nothing waiting"
      }
      actions={
        <button
          type="button"
          className="sm ghost"
          id="ackAll"
          disabled={busy || unacked.length === 0}
          onClick={() => ack(unacked)}
        >
          Acknowledge all
        </button>
      }
    >
      <div className="scroll" id="cNeeds">
        {items !== undefined && list.length === 0 && replies === 0 && (
          <div className="pb muted">Nothing needs you right now.</div>
        )}
        {error && <div className="pb crit-t s">{error}</div>}
        {replies > 0 && (
          // no Ack: it clears when the operator has looked at the Chat tab
          <div className="nrow" data-kind="message">
            <div>
              <span className="kind">{ATTENTION_LABEL.message}</span>{" "}
              <span>{replies > 1 ? `FLIGHT replied (${replies})` : "FLIGHT replied"}</span>
            </div>
            <div className="acts">
              <button type="button" className="sm" onClick={openDockChat}>
                Open the chat
              </button>
            </div>
          </div>
        )}
        {list.map((i) => {
          const lamp = needsLamp([i], !i.acked);
          const agentId = i.agentId;
          const row = rows.find((r) => r.id === agentId);
          const target = answerTarget(i, rows, flightSeat);
          return (
            <div key={i.key} className={i.acked ? "nrow acked" : "nrow"} data-kind={i.kind}>
              {lamp && <Lamp {...lamp} />}
              <div>
                <span className="kind">{ATTENTION_LABEL[i.kind]}</span>{" "}
                {agentId !== null && <AgentTag id={agentId} index={row?.index ?? 0} sm />}{" "}
                <NeedText item={i} now={now} />
                {i.brief && (
                  <>
                    <div className="xs fg2">
                      FLIGHT recommends:{" "}
                      <MarkdownInline text={i.brief.recommendation} max={NEED_TEXT_MAX} />
                    </div>
                    {target.to !== "github" && (
                      <BriefOptions
                        options={i.brief.options}
                        live
                        disabled={busy || !(target.to === "seat" || flightSeat?.live === true)}
                        title={
                          target.to === "flight" && flightSeat?.live !== true
                            ? FLIGHT_NOT_RUNNING
                            : undefined
                        }
                        variant="row"
                        onPick={(o) => answer(target, i, o.answer)}
                      />
                    )}
                  </>
                )}
              </div>
              <div className="acts">
                {i.escalationId === null && (
                  <button type="button" className="sm primary" onClick={() => openItem(i.key)}>
                    {i.brief ? "Read the brief" : "Discuss"}
                  </button>
                )}
                {i.escalationId !== null ? (
                  <>
                    <button type="button" className="sm primary" onClick={() => openItem(i.key)}>
                      Read the brief
                    </button>
                    {i.url && <ExternalLink url={i.url}>Open on GitHub ↗</ExternalLink>}
                  </>
                ) : i.kind === "pr" ? (
                  i.url && <ExternalLink url={i.url}>Open PR ↗</ExternalLink>
                ) : (
                  // a stray is only acknowledged: the commit tool already set it aside
                  i.kind !== "stray" &&
                  agentId !== null && (
                    <button
                      type="button"
                      className="sm"
                      onClick={() => navigate(agentPath(agentId))}
                    >
                      Open
                    </button>
                  )
                )}
                {!i.acked && (
                  <button
                    type="button"
                    className="sm ghost"
                    disabled={busy}
                    onClick={() => ack([i.key])}
                  >
                    Ack
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {handled.length > 0 && (
        <details id="cHandled" className="guard">
          <summary>Being handled · {handled.length}</summary>
          {handled.map((i) => (
            <div key={i.key} className="nrow" data-kind={i.kind}>
              <div>
                <span className="kind">{ATTENTION_LABEL[i.kind]}</span>{" "}
                <span className="xs muted">{ownerLabel(itemOwner(i))}</span>{" "}
                <NeedText item={i} now={now} />
              </div>
            </div>
          ))}
        </details>
      )}
      <GuardDrawer rows={rows} busy={busy} ack={ack} />
    </Panel>
  );
}

/** Guard hits this week (catalogue 2.5.1): for information, each with its own Ack. */
function GuardDrawer({
  rows,
  busy,
  ack,
}: {
  rows: CrewRow[];
  busy: boolean;
  ack: (keys: string[]) => Promise<void>;
}) {
  const view = useResource<GuardHitsView>(RESOURCES.guardHits).data;
  const hits = view?.hits;
  // the whole window's count (the list is capped), so this and Setup's Hits column agree
  const total = view ? Object.values(view.counts).reduce((a, b) => a + b, 0) : 0;
  const tz = useTz();
  const drawer = useRef<HTMLDetailsElement>(null);
  const rendered = hits !== undefined;
  // `/comms#cGuard` (the Telemetry Guard tile's link) opens the drawer and scrolls to it, once it
  // has rendered, and again whenever the hash changes to it with Comms already open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `rendered` is the re-run trigger
  useEffect(() => {
    const openFromHash = () => {
      if (window.location.hash === `#${GUARD_DRAWER_ID}` && drawer.current) {
        drawer.current.open = true;
        drawer.current.scrollIntoView?.();
      }
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [rendered]);
  if (hits === undefined) return null;
  return (
    <details id={GUARD_DRAWER_ID} ref={drawer} className="guard">
      <summary>
        {total === 0 ? GUARD_NONE_TEXT : guardSummary(total, hits.filter((h) => !h.acked).length)}
      </summary>
      {hits.map((h) => (
        <div key={h.id} className={h.acked ? "nrow acked" : "nrow"}>
          <span className="warn-t" aria-hidden="true">
            ⊘
          </span>
          <div className="min0">
            <AgentTag id={h.agentId} index={rows.find((r) => r.id === h.agentId)?.index ?? 0} sm />{" "}
            <span className="s">{h.text}</span>
            <br />
            <span className="xs muted num">
              {tz === null ? "—" : clockHm(h.at, tz)} · rule: {h.rule}
            </span>
          </div>
          {!h.acked && (
            <div className="acts">
              <button
                type="button"
                className="sm ghost"
                aria-label={`Ack: ${h.text}`}
                disabled={busy}
                onClick={() => ack([guardAckKey(h.id)])}
              >
                Ack
              </button>
            </div>
          )}
        </div>
      ))}
    </details>
  );
}
