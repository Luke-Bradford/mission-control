import {
  ATTENTION_LABEL,
  type AttentionItem,
  type Crew,
  type Escalation,
  FLIGHT_NOT_RUNNING,
  type FlightView,
  type TicketView,
} from "@mc/core";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { apiPost, errorNote } from "../api.ts";
import { useNow, useTz } from "../clock.ts";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { Markdown, MarkdownInline } from "../components/Markdown.tsx";
import { ACTIONS, RESOURCES, useResource } from "../data.ts";
import { dayMonth, rel } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Pill } from "../hud/Pill.tsx";
import { RepoRef } from "../hud/RepoRef.tsx";
import { agentPath, followLink } from "../router.ts";
import { BuildChips } from "./buildStatus.tsx";
import { closeItem, trapTab, useItem, useOverlay, useReturnFocus } from "./overlays.ts";

/** An escalation opened less than this long ago is New, an older one a Follow-up. */
const NEW_MS = 24 * 3_600_000;

/** An issue body longer than this many lines is cut until "Show all". */
export const BODY_LINES = 40;

/**
 * The Item panel (catalogue §2.9.1): a 540px fly-out for one thing that needs the operator. An escalation
 * shows the loop's question, its reasoning and its options (all inert text), and sends the answer
 * to GitHub; FLIGHT's chat is switched off until it runs.
 */
export function ItemPanel() {
  const key = useItem();
  useOverlay("item", key !== null, () => closeItem());
  const items = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const escRes = useResource<Escalation[]>(RESOURCES.escalations);
  const escalations = escRes.data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const seat = useResource<FlightView>(RESOURCES.flight).data?.seat ?? null;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tz = useTz();
  const now = useNow();
  const head = useId();
  const close = useRef<HTMLButtonElement>(null);
  useReturnFocus(key !== null);
  useEffect(() => {
    if (key !== null) close.current?.focus();
  }, [key]);
  if (key === null) return null;

  const item = items?.find((i) => i.key === key);
  const esc = item?.escalationId ? escalations?.find((e) => e.id === item.escalationId) : undefined;
  // An escalation item waits for its escalations rather than flash the generic view.
  const holding = Boolean(item?.escalationId) && escalations === undefined && escRes.error === null;
  const agentId = item?.agentId ?? null;
  const agentIndex = crew?.rows.find((r) => r.id === agentId)?.index ?? 0;
  const live = seat?.live === true;
  const send = async (ev: FormEvent) => {
    ev.preventDefault();
    const body = text.trim();
    if (!seat?.live || body === "") return;
    // Led by the item's title, so FLIGHT knows what the question is about.
    const about = esc?.title ?? item?.text ?? "";
    setBusy(true);
    setErr(null);
    try {
      await apiPost(ACTIONS.seatMessage(seat.id), {
        text: about === "" ? body : `Re: ${about}\n\n${body}`,
      });
      setText("");
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      setErr(errorNote(error) ?? error.message);
    } finally {
      setBusy(false);
    }
  };
  const when = (ms: number): string => (tz ? rel(ms, now, tz) : "—");

  return (
    <aside className="flyout" id="discuss" aria-labelledby={head} onKeyDown={trapTab}>
      <div className="panel">
        <div className="ph" id="dsHead">
          <h2 id={head}>{item ? ATTENTION_LABEL[item.kind] : "Item"}</h2>
          {agentId !== null && <AgentTag id={agentId} index={agentIndex} sm />}
          {item && !holding && (
            <span className="sub">{esc ? `opened ${when(esc.openedAt)}` : when(item.at)}</span>
          )}
          <BuildChips panel="discuss" />
          <span className="act">
            <button type="button" className="sm" ref={close} onClick={() => closeItem()}>
              Close
            </button>
          </span>
        </div>
        <div className="pb" id="dsBrief">
          {!item || holding ? (
            <p className="note">
              {items === undefined || item ? "Loading…" : "This item is no longer open."}
            </p>
          ) : esc ? (
            <EscalationBrief esc={esc} tz={tz} now={now} />
          ) : (
            <div className="brief">
              <div className="s qtext">
                <Markdown text={item.text} />
              </div>
              <div className="row">
                {agentId !== null && (
                  <a href={agentPath(agentId)} onClick={(e) => followLink(e, agentPath(agentId))}>
                    Open {agentId}
                  </a>
                )}
                {item.url && <ExternalLink url={item.url}>Open on GitHub ↗</ExternalLink>}
              </div>
            </div>
          )}
        </div>
        {esc && (
          <div className="composer" id="dsOpts">
            {esc.question && (
              <div className="optlist">
                {esc.question.answers.map((a, i) => (
                  <div
                    className={a === esc.question?.recommendation ? "opt rec" : "opt"}
                    // Answers can repeat, so the text is no key; the list never reorders.
                    // biome-ignore lint/suspicious/noArrayIndexKey: position is the only id, see above
                    key={i}
                  >
                    <span className="row">
                      <b className="qtext">
                        <MarkdownInline text={a} />
                      </b>
                      {a === esc.question?.recommendation && <Pill tone="plain">Recommended</Pill>}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="row">
              <ExternalLink url={esc.url}>Answer on GitHub ↗</ExternalLink>
            </div>
          </div>
        )}
        <form className="composer" id="dsForm" onSubmit={(e) => void send(e)}>
          <input
            id="dsInput"
            autoComplete="off"
            aria-label="Ask FLIGHT about this"
            placeholder="Ask FLIGHT about this…"
            title={live ? undefined : FLIGHT_NOT_RUNNING}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!live}
          />
          <button
            type="submit"
            className="primary"
            title={live ? undefined : FLIGHT_NOT_RUNNING}
            disabled={!live || busy}
          >
            Send
          </button>
          {err !== null && (
            <p className="note err" role="alert">
              {err}
            </p>
          )}
        </form>
      </div>
    </aside>
  );
}

function EscalationBrief({ esc, tz, now }: { esc: Escalation; tz: string | null; now: number }) {
  const fresh = now - esc.openedAt < NEW_MS;
  const q = esc.question;
  return (
    <div className="brief">
      <div className="ctx">
        <span className="bsec">Catch-up</span>
        <div className="ctxline">
          <Pill tone={fresh ? "plain" : "warn"}>{fresh ? "New" : "Follow-up"}</Pill>
          <span>
            Opened {tz ? dayMonth(esc.openedAt, tz) : "—"} on{" "}
            <RepoRef repoId={esc.repoId} number={esc.issueNumber} url={esc.url} />
          </span>
        </div>
      </div>
      <b className="btitle qtext">
        <MarkdownInline text={esc.title} />
      </b>
      {!q && <IssueBody key={esc.id} esc={esc} />}
      {q && (
        <>
          <div className="bsec">What is being asked</div>
          <div className="s qtext">
            <Markdown text={q.question} />
          </div>
          <div className="bsec">Why it came to you</div>
          <div className="s fg2 qtext">
            <Markdown text={q.reasoning_quote} />
          </div>
          <div className="bsec">Effort so far</div>
          <div className="s fg2 qtext">
            <Markdown text={q.effort_sunk} />
          </div>
          <div className="bsec">If nobody answers</div>
          <div className="s fg2 qtext">
            <Markdown text={q.default_if_ignored} />
          </div>
          <IssueBody key={esc.id} esc={esc} folded />
        </>
      )}
    </div>
  );
}

/** Show all / Show less; `of` names what it shows, for a screen reader. */
function Toggle({ on, of, onClick }: { on: boolean; of?: string; onClick: () => void }) {
  const text = on ? "Show less" : "Show all";
  return (
    <button
      type="button"
      className="sm"
      aria-expanded={on}
      aria-label={of ? `${text}, ${of}` : undefined}
      onClick={onClick}
    >
      {text}
    </button>
  );
}

/**
 * The question's own text: the escalation's issue body, from the ticket resource. With no
 * structured question it shows at once (cut past BODY_LINES); with one it stays folded until asked
 * for, and is not fetched before. Once asked for it stays subscribed, so hiding and showing it
 * again makes no new request. The caller keys it on the escalation, so no state carries over.
 */
function IssueBody({ esc, folded = false }: { esc: Escalation; folded?: boolean }) {
  const [open, setOpen] = useState(!folded);
  const [asked, setAsked] = useState(!folded);
  const [all, setAll] = useState(false);
  const res = useResource<TicketView>(asked ? RESOURCES.ticket(esc.repoId, esc.issueNumber) : null);
  const t = res.data;
  const body = t?.body.trim() ?? "";
  const lines = body.split("\n");
  const long = lines.length > BODY_LINES;
  const cut = !folded && !all && long;
  return (
    <>
      {folded && (
        <Toggle
          on={open}
          of="the issue's text"
          onClick={() => {
            setAsked(true);
            setOpen(!open);
          }}
        />
      )}
      {open && t === undefined && !res.error && <p className="note">Loading…</p>}
      {open && res.error && !t && (
        <p className="crit-t s">Could not load the question: {res.error.message}</p>
      )}
      {open && body !== "" && (
        <>
          <div className="s qtext">
            <Markdown text={cut ? lines.slice(0, BODY_LINES).join("\n") : body} />
          </div>
          {t?.bodyTruncated && (
            <p className="s">
              <ExternalLink url={t.url}>Continue on GitHub ↗</ExternalLink>
            </p>
          )}
          {!folded && long && <Toggle on={all} onClick={() => setAll(!all)} />}
        </>
      )}
    </>
  );
}
