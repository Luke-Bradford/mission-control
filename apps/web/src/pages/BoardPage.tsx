import {
  type AttentionItem,
  type BoardItem,
  type ConfigView,
  type Crew,
  DONE_RANGES,
  HUD_COLUMNS,
  type HudColumn,
  type PullRequestView,
  type RepoProfile,
  type RepoView,
  startOfLocalDay,
} from "@mc/core";
import { useEffect, useMemo, useState } from "react";
import { BriefModal } from "../board/BriefModal.tsx";
import { standup, weekly } from "../board/brief.ts";
import {
  cardAgent,
  cardColumn,
  cardQueue,
  daysAgo,
  needsMe,
  priorityRank,
} from "../board/cards.ts";
import { Kanban } from "../board/Kanban.tsx";
import { ALL_LANE, lanesFor, MINE_LANE, resolveLane } from "../board/lanes.ts";
import { type BoardLayout, type DoneRange, Toolbar } from "../board/Toolbar.tsx";
import { useNow, useTz } from "../clock.ts";
import { TicketDetail } from "../components/TicketDetail.tsx";
import { RESOURCES, useResource, useResources } from "../data.ts";
import { boardPath, followLink, navigate, setupPath } from "../router.ts";
import { inSession, SESSION_ALL, useSession } from "../shell/session.ts";
import { BOARD_LAYOUT_KEY, LANE_KEY, readKey, writeKey } from "../storage.ts";

const NO_REPOS: RepoView[] = [];
const NO_PROFILES: RepoProfile[] = [];

/**
 * Where a repo's priority comes from: the source the collector actually reads, not the commonest
 * value. A Project field value wins over a label, a label over nothing.
 */
function prioritySource(p: RepoProfile): string {
  if (p.priority.field > 0) return "Project field";
  return p.priority.label > 0 ? "p0\u2013p3 labels" : "nowhere";
}

/** The columns a repo's statuses reach, plus Backlog and Done (and any column its cards sit in). */
function columnsOf(p: RepoProfile | undefined, items: BoardItem[]): HudColumn[] {
  if (!p) return [...HUD_COLUMNS];
  const reached = new Set<HudColumn>(["Backlog", "Done", ...p.statuses.map((s) => s.column)]);
  for (const i of items) reached.add(cardColumn(i));
  return HUD_COLUMNS.filter((c) => reached.has(c));
}

/**
 * Board (catalogue §2.3): lanes, the eight columns, and a ticket beside them. The cards are the
 * issues hub's board; Mission Control adds only the agent, PR and CI line.
 */
export function BoardPage({ repoId, ticket }: { repoId: string | null; ticket: number | null }) {
  const repos = useResource<RepoView[]>(RESOURCES.repos).data ?? NO_REPOS;
  const boards = useResources<BoardItem[]>(repos.map((r) => RESOURCES.boards(r.id)));
  const prRes = useResources<PullRequestView[]>(repos.map((r) => RESOURCES.prs(r.id)));
  const crew = useResource<Crew>(RESOURCES.crew).data?.rows;
  const attention = useResource<AttentionItem[]>(RESOURCES.attention).data;
  // The GitHub login the hub acts as (#395 adds it to the config view). `operator.id` is the hub's own
  // operator id, not a GitHub login, so All mine waits for this and is not offered until it is known.
  const config = useResource<ConfigView>(RESOURCES.config).data as
    | (ConfigView & { githubLogin?: string | null })
    | undefined;
  const operatorId = config?.githubLogin ?? null;
  const tz = useTz();
  const now = useNow();
  const [session] = useSession();
  const profiles = useResource<RepoProfile[]>(RESOURCES.repoProfiles).data ?? NO_PROFILES;

  const [stored, setStored] = useState(() => readKey(LANE_KEY));
  const [doneDays, setDoneDays] = useState<DoneRange>(DONE_RANGES[0]);
  const [priority, setPriority] = useState("");
  const [agentOnly, setAgentOnly] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [storedLayout, setStoredLayout] = useState(() => readKey(BOARD_LAYOUT_KEY));

  const ticketRoute = repoId !== null && ticket !== null;
  const lanes = useMemo(() => lanesFor(repos, session, operatorId), [repos, session, operatorId]);
  const lane = resolveLane(lanes, repoId, stored, ticketRoute);
  // /board/:repo selects that repo's lane and is then remembered; a ticket route does not.
  useEffect(() => {
    if (!ticketRoute && repoId !== null && lane.id === repoId && readKey(LANE_KEY) !== repoId) {
      writeKey(LANE_KEY, repoId);
      setStored(repoId);
    }
  }, [ticketRoute, repoId, lane.id]);
  // Under a session the lane is the session's; say so when the route or stored lane names another.
  const named = repoId ?? stored;
  const otherRepo =
    session !== SESSION_ALL &&
    named !== null &&
    named !== ALL_LANE &&
    named !== session &&
    repos.some((r) => r.id === named)
      ? named
      : null;
  // The layout applies only to All repos with two or more repos (never under a session).
  const layoutOn = lane.id === ALL_LANE && repos.length >= 2;
  const layout: BoardLayout = storedLayout === "apart" ? "apart" : "together";
  const pickLayout = (l: BoardLayout) => {
    writeKey(BOARD_LAYOUT_KEY, l);
    setStoredLayout(l);
  };
  const pickLane = (id: string) => {
    writeKey(LANE_KEY, id);
    setStored(id);
    navigate(id === ALL_LANE || id === MINE_LANE ? "/board" : boardPath(id));
  };

  const all = useMemo(() => boards.flatMap((b) => b.data ?? []), [boards]);
  const prs = useMemo(() => prRes.flatMap((p) => p.data ?? []), [prRes]);
  const rows = crew ?? [];
  const items = attention ?? [];

  // Once per render, not once per card (#26 A1).
  const todayStart = tz === null ? null : startOfLocalDay(now, tz);
  const inLane = all.filter((i) => {
    if (!lane.match(i) || !inSession(session, i.repoId)) return false;
    if (cardColumn(i) === "Done") return daysAgo(i.updatedAt, now, tz, todayStart) <= doneDays;
    return true;
  });
  const shown = inLane.filter(
    (i) =>
      (priority === "" || i.priority === priority) &&
      (!agentOnly || cardAgent(i, rows) !== null || cardQueue(i, rows) !== null) &&
      (!mineOnly || needsMe(i, items, rows)),
  );
  const priorities = [
    ...new Set(inLane.map((i) => i.priority).filter((p): p is string => p !== null)),
  ].sort((a, b) => priorityRank(a) - priorityRank(b) || a.localeCompare(b));

  const ctx = { laneName: lane.name, prs, crew: rows, attention: items };
  const briefText = (mode: "standup" | "weekly"): string => {
    if (tz === null) return "Loading…";
    return mode === "standup"
      ? standup(inLane, ctx, now, tz)
      : weekly(inLane, ctx, doneDays, now, tz);
  };

  const notIn = useMemo(() => {
    const m = new Map<HudColumn, string[]>();
    for (const p of profiles) {
      if (!repos.some((r) => r.id === p.id)) continue;
      for (const c of p.missingColumns) m.set(c, [...(m.get(c) ?? []), p.id]);
    }
    return m;
  }, [profiles, repos]);
  const kanbanProps = {
    prs,
    crew: rows,
    attention: items,
    now,
    tz,
    todayStart,
  };

  const errors = boards.flatMap((b, i) => (b.error ? [`${repos[i]?.id}: ${b.error.message}`] : []));
  const loading = repos.length > 0 && boards.some((b) => !b.data && !b.error);
  const detailItem =
    repoId !== null && ticket !== null
      ? all.find((i) => i.repoId === repoId && i.issueNumber === ticket)
      : undefined;

  return (
    <section id="page-board">
      <Toolbar
        lanes={lanes}
        lane={lane}
        onLane={pickLane}
        priorities={priorities}
        priority={priority}
        onPriority={setPriority}
        agentOnly={agentOnly}
        onAgentOnly={setAgentOnly}
        mineOnly={mineOnly}
        onMineOnly={setMineOnly}
        doneDays={doneDays}
        onDoneDays={setDoneDays}
        onBrief={() => setBriefOpen(true)}
        layout={layoutOn ? layout : null}
        onLayout={pickLayout}
      />
      {loading && <p className="muted s">Loading the board…</p>}
      {errors.map((e) => (
        <p key={e} className="crit-t s">
          Could not load the board — {e}
        </p>
      ))}
      {otherRepo !== null && (
        <p className="s muted">
          Showing s/{session}. Choose All sessions to see {otherRepo}.
        </p>
      )}
      <div className={`boardsplit${ticketRoute ? " withdetail" : ""}`}>
        {layoutOn && layout === "apart" ? (
          <div className="repokanbans">
            {repos.map((r) => {
              const p = profiles.find((x) => x.id === r.id);
              const own = shown.filter((i) => i.repoId === r.id);
              return (
                <section key={r.id} className="repokanban">
                  <div className="rkh">
                    <h3 className="s">
                      {[
                        r.id,
                        p ? `Priority from ${prioritySource(p)}` : null,
                        p && p.missingColumns.length > 0
                          ? `Lacks ${p.missingColumns.join(", ")}`
                          : null,
                      ]
                        .filter((x) => x !== null)
                        .join(" \u00b7 ")}
                    </h3>
                    <a
                      className="xs"
                      href={setupPath("repos")}
                      onClick={(e) => followLink(e, setupPath("repos"))}
                    >
                      How its statuses map
                    </a>
                  </div>
                  <Kanban
                    items={own}
                    showRepo={false}
                    columns={columnsOf(p, own)}
                    id={`kanban-${r.id}`}
                    {...kanbanProps}
                  />
                </section>
              );
            })}
          </div>
        ) : (
          <Kanban
            items={shown}
            showRepo={lane.id === ALL_LANE || lane.id === MINE_LANE}
            notIn={layoutOn ? notIn : undefined}
            {...kanbanProps}
          />
        )}
        {repoId !== null && ticket !== null && (
          <TicketDetail
            repoId={repoId}
            number={ticket}
            item={detailItem}
            agent={detailItem ? cardAgent(detailItem, rows) : null}
          />
        )}
      </div>
      <BriefModal open={briefOpen} onClose={() => setBriefOpen(false)} text={briefText} />
    </section>
  );
}
