import { type AttentionItem, FLIGHT_TRIAGE_LABEL } from "@mc/core";
import { ownerLabel } from "../attention.ts";
import { useSecond, useTz } from "../clock.ts";
import { NEED_TEXT_MAX, needText } from "../comms/needText.ts";
import { MarkdownInline } from "../components/Markdown.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { rel } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { followLink, NEEDS_YOU_PATH } from "../router.ts";
import { openItem } from "../shell/overlays.ts";
import { useSessionScope } from "../shell/session.ts";
import { Drafts } from "./Drafts.tsx";
import { WatchList } from "./HeldNeeds.tsx";
import { needsGroups } from "./needsGroups.ts";
import { Pending } from "./Pending.tsx";
import { PrFlowPanel } from "./PrFlowPanel.tsx";

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

/**
 * Handling: the PR flow, what FLIGHT is handling, what is held, what waits on others and the draft
 * replies. The asks themselves are on the Needs you page.
 */
export function NeedsYouTab() {
  const attentionRes = useResource<AttentionItem[]>(RESOURCES.attention);
  const attention = attentionRes.data;
  const heldRes = useResource<AttentionItem[]>(RESOURCES.heldAttention);
  const held = heldRes.data;
  const { inRepo } = useSessionScope();
  const { handling, waiting } = needsGroups(
    attention,
    (i) => i.repoId === null || inRepo(i.repoId),
  );
  return (
    <>
      <p className="flight-needs-link">
        <a href={NEEDS_YOU_PATH} onClick={(e) => followLink(e, NEEDS_YOU_PATH)}>
          Open Needs you
        </a>
      </p>
      <PrFlowPanel />
      <div className="flight-needs-groups">
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
        <Panel id="heldP" title="Watch list" sub={`${held?.length ?? 0} on a condition`}>
          <div className="flight-panel-scroll">
            {held === undefined ? (
              <Pending what="held items" error={heldRes.error} resource={RESOURCES.heldAttention} />
            ) : held.length === 0 ? (
              <p className="pb note">{NOTHING_HELD}</p>
            ) : (
              <WatchList />
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
