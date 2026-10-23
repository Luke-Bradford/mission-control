import { ATTENTION_LABEL, type AttentionItem } from "@mc/core";
import { isOperatorItem } from "../attention.ts";
import { useSecond } from "../clock.ts";
import { NEED_TEXT_MAX, needText, sortNeeds } from "../comms/NeedsList.tsx";
import { MarkdownInline } from "../components/Markdown.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { Pill } from "../hud/Pill.tsx";
import { openItem } from "../shell/overlays.ts";
import { inSession, useSession } from "../shell/session.ts";

const DASH = "—";
export const NOBODY_WAITING = "Nobody is waiting on you.";

/** Asked of you (catalogue §2.2.2): the operator's Needs-you items, with FLIGHT's take where it briefed one. */
export function AskedOfYou() {
  const attention = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const now = useSecond();
  const [session] = useSession();
  if (attention === undefined) return <p className="pb note">{DASH}</p>;
  // An item with no repo belongs to no session, so it stays in view (as in Situation).
  const items = sortNeeds(
    attention.filter(
      (i) => isOperatorItem(i) && (i.repoId === null || inSession(session, i.repoId)),
    ),
  );
  if (items.length === 0) return <p className="pb note">{NOBODY_WAITING}</p>;
  return (
    <div>
      {items.map((i) => (
        <div className="drow" key={i.key} data-testid="ask-row">
          <div className="row">
            <Pill tone={i.kind === "decision" ? "warn" : "plain"}>{ATTENTION_LABEL[i.kind]}</Pill>
            <span className="min0">
              <MarkdownInline text={needText(i, now)} max={NEED_TEXT_MAX} />
            </span>
            <span className="spacer" />
            <button type="button" className="sm" onClick={() => openItem(i.key)}>
              Open
            </button>
          </div>
          {i.brief && (
            <div className="s">
              <b>FLIGHT's take:</b> <MarkdownInline text={i.brief.recommendation} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
