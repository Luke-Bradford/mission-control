import { type AttentionItem, type BoardItem, FLIGHT_NOT_RUNNING, type RepoView } from "@mc/core";
import { cardColumn } from "../board/cards.ts";
import { RESOURCES, useResource, useResources } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { navigate, PAGE_PATHS } from "../router.ts";
import { inSession, useSession } from "../shell/session.ts";
import { Timeline } from "./Timeline.tsx";

const NO_REPOS: RepoView[] = [];

const count = (items: AttentionItem[], kinds: AttentionItem["kind"][]): number =>
  items.filter((i) => kinds.includes(i.kind)).length;

/**
 * FLIGHT › Situation (catalogue 2.2.1): FLIGHT's paragraph waits for FLIGHT; the stats strip and
 * the timeline are computed from today's data.
 */
export function Situation() {
  const repos = useResource<RepoView[]>(RESOURCES.repos).data ?? NO_REPOS;
  const boards = useResources<BoardItem[]>(repos.map((r) => RESOURCES.boards(r.id)));
  const attention = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const [session] = useSession();
  const loaded = repos.length > 0 && boards.every((b) => b.data !== undefined);
  const all = boards.flatMap((b) => b.data ?? []).filter((i) => inSession(session, i.repoId));
  const inColumn = (...cols: string[]): string =>
    loaded ? String(all.filter((i) => cols.includes(cardColumn(i))).length) : "—";
  // An item with no repo belongs to no session, so it stays in view (as on the Activity panel).
  const items = (attention ?? []).filter((i) => i.repoId === null || inSession(session, i.repoId));
  const known = attention !== undefined;
  const num = (n: number): string => (known ? String(n) : "—");
  const decisions = count(items, ["decision"]);
  const approvals = count(items, ["approval", "question"]);
  const stalls = count(items, ["stalled", "error"]);

  return (
    <Panel
      id="sitP"
      title="Situation"
      sub="FLIGHT's read of everything, updated as things change"
      phase="P2"
    >
      <div className="pb">
        <p className="sittext note">{FLIGHT_NOT_RUNNING}</p>
        <div className="sitstats">
          <span>
            <b className="num">{inColumn("In progress")}</b> tickets in progress
          </span>
          <span>
            <b className="num">{inColumn("In review", "Ready for QA")}</b> waiting on other people
          </span>
          <span className={decisions > 0 ? "warn" : undefined}>
            <b className="num">{num(decisions)}</b> {decisions === 1 ? "decision" : "decisions"} for
            you
          </span>
          <span>
            <b className="num">{num(approvals)}</b> routine{" "}
            {approvals === 1 ? "approval" : "approvals"}
          </span>
          <span>
            <b className="num">{num(stalls)}</b> {stalls === 1 ? "stall" : "stalls"}
          </span>
          {(decisions > 0 || approvals > 0) && (
            <button type="button" className="primary" onClick={() => navigate(PAGE_PATHS.comms)}>
              Open what needs you
            </button>
          )}
        </div>
      </div>
      <Timeline />
    </Panel>
  );
}
