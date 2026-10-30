import { type AttentionItem, FLIGHT_TRIAGE_LABEL } from "@mc/core";
import { ownerLabel } from "../attention.ts";
import { useSecond, useTz } from "../clock.ts";
import { NEED_TEXT_MAX, needText } from "../comms/needText.ts";
import { MarkdownInline } from "../components/Markdown.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { dur, rel } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { NEEDS_YOU_PANEL } from "../router.ts";
import { openItem } from "../shell/overlays.ts";
import { useSessionScope } from "../shell/session.ts";
import { AskedOfYou } from "./AskedOfYou.tsx";
import { Drafts } from "./Drafts.tsx";
import { HeldNeeds } from "./HeldNeeds.tsx";
import { needsGroups } from "./needsGroups.ts";
import { Pending } from "./Pending.tsx";

export const NOTHING_DEFAULTED = "FLIGHT has no default waiting on your objection.";
export const NOTHING_HANDLING = "FLIGHT is not handling anything for you right now.";
export const NOTHING_HELD = "Nothing is held.";
export const NOBODY_ELSE = "Nothing is waiting on anyone else.";

/** One line of a non-asking group: what it is, who has it, how long, and a way in. */
function Line({ item, note }: { item: AttentionItem; note?: string }) {
  const now = useSecond();
  const tz = useTz();
  return (
    <div className="drow" data-testid="needs-line">
      <div className="row">
        <span className="min0">
          <MarkdownInline text={needText(item, now)} max={NEED_TEXT_MAX} />
        </span>
        <span className="spacer" />
        {item.at > 0 && tz !== null && <span className="s">{rel(item.at, now, tz)}</span>}
        <button type="button" className="sm" onClick={() => openItem(item.key)}>
          Open
        </button>
      </div>
      {note && <div className="s note">{note}</div>}
    </div>
  );
}

/** What FLIGHT will do on its own, and when, for an ask that carries a default. */
function defaultNote(item: AttentionItem, now: number): string {
  const rec = item.brief?.recommendation;
  const due = item.defaultDueAt;
  const when =
    due === undefined ? "" : due <= now ? " · applies now" : ` · applies in ${dur(due - now)}`;
  return `${rec ? `Recommended: ${rec}` : "Applies the recommended option"}${when}`;
}

/**
 * Needs you: the canonical asks with their full briefs, then what FLIGHT will do unless you object,
 * what it is handling, what is held, and what waits on others. Each item is in one group only.
 */
export function NeedsYouTab() {
  const attentionRes = useResource<AttentionItem[]>(RESOURCES.attention);
  const attention = attentionRes.data;
  const heldRes = useResource<AttentionItem[]>(RESOURCES.heldAttention);
  const held = heldRes.data;
  const now = useSecond();
  const { inRepo } = useSessionScope();
  const { defaulted, handling, waiting } = needsGroups(
    attention,
    (i) => i.repoId === null || inRepo(i.repoId),
  );
  return (
    <>
      <Panel id={NEEDS_YOU_PANEL} title="Needs you" sub="decisions and replies only you can make">
        <div className="flight-panel-scroll">
          <AskedOfYou withDefaults={false} withHeld={false} />
        </div>
      </Panel>
      <div className="flight-needs-groups">
        <Panel
          id="defaultsP"
          title="FLIGHT will do unless you object"
          sub={`${defaulted.length} with a default`}
        >
          <div className="flight-panel-scroll">
            {attention === undefined ? (
              <Pending
                what="what needs you"
                error={attentionRes.error}
                resource={RESOURCES.attention}
              />
            ) : defaulted.length === 0 ? (
              <p className="pb note">{NOTHING_DEFAULTED}</p>
            ) : (
              defaulted.map((i) => <Line key={i.key} item={i} note={defaultNote(i, now)} />)
            )}
          </div>
        </Panel>
        <Panel id="handlingP" title="FLIGHT is handling" sub={`${handling.length} owned`}>
          <div className="flight-panel-scroll">
            {attention === undefined ? (
              <Pending
                what="what needs you"
                error={attentionRes.error}
                resource={RESOURCES.attention}
              />
            ) : handling.length === 0 ? (
              <p className="pb note">{NOTHING_HANDLING}</p>
            ) : (
              handling.map((i) => (
                <Line
                  key={i.key}
                  item={i}
                  note={
                    i.brief?.assessment ??
                    i.brief?.context ??
                    FLIGHT_TRIAGE_LABEL[i.flightTriage ?? "handling"]
                  }
                />
              ))
            )}
          </div>
        </Panel>
        <Panel id="heldP" title="Held" sub={`${held?.length ?? 0} on a condition`}>
          <div className="flight-panel-scroll">
            {held === undefined ? (
              <Pending what="held items" error={heldRes.error} resource={RESOURCES.heldAttention} />
            ) : held.length === 0 ? (
              <p className="pb note">{NOTHING_HELD}</p>
            ) : (
              <HeldNeeds />
            )}
          </div>
        </Panel>
        <Panel id="waitingP" title="Waiting on others" sub={`${waiting.length} not yours`}>
          <div className="flight-panel-scroll">
            {attention === undefined ? (
              <Pending
                what="what needs you"
                error={attentionRes.error}
                resource={RESOURCES.attention}
              />
            ) : waiting.length === 0 ? (
              <p className="pb note">{NOBODY_ELSE}</p>
            ) : (
              waiting.map((i) => (
                <Line key={i.key} item={i} note={`With ${ownerLabel(i.owner ?? "operator")}`} />
              ))
            )}
          </div>
        </Panel>
      </div>
      <Panel
        id="draftsP"
        title="Draft replies"
        sub="full working space for replies awaiting approval"
      >
        <div className="flight-panel-scroll">
          <Drafts />
        </div>
      </Panel>
    </>
  );
}
