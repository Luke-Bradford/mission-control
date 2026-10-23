import type { CrewRow, FlightBriefView, FlightWatchEntry, TestLockState } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { useSecond, useTz } from "../clock.ts";
import { Markdown } from "../components/Markdown.tsx";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { rel } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { CATCH_UP_LABEL } from "../notifications.ts";
import { draftRowId } from "./Drafts.tsx";
import { FLIGHT_NO_SEAT } from "./flightTypes.ts";

const DASH = "—";
export const BRIEF_EMPTY = "Nothing here yet.";
export const SITUATION_EMPTY = "FLIGHT has not written its goals or what is in progress yet.";
export const WATCH_EMPTY = "FLIGHT is not watching anything yet.";

/** When a section was last changed: "never updated", "updated —" until the timezone is known. */
export function briefUpdated(at: number | null, now: number, tz: string | null): string {
  if (at === null) return "never updated";
  return tz === null ? `updated ${DASH}` : `updated ${rel(at, now, tz)}`;
}

/** Situation's paragraph: the brief's goals, then what is in progress, as FLIGHT wrote them. */
export function situationText(view: FlightBriefView): string {
  return ["goals", "in_progress"]
    .map((key) => view.sections.find((s) => s.section === key)?.text.trim() ?? "")
    .filter((t) => t !== "")
    .join("\n\n");
}

/** FLIGHT's brief as the hub holds it; undefined until it loads. */
export const useBrief = (): FlightBriefView | undefined =>
  useResource<FlightBriefView>(RESOURCES.flightBrief).data;

/** FLIGHT › FLIGHT's brief: its nine sections, each with when FLIGHT last changed it. */
export function BriefPanel() {
  const view = useBrief();
  const now = useSecond();
  const tz = useTz();
  return (
    <Panel
      id="briefP"
      title="FLIGHT's brief"
      sub="FLIGHT's working memory · each section says when FLIGHT last changed it"
    >
      {view === undefined ? (
        <p className="pb note">{DASH}</p>
      ) : view.session === null ? (
        <p className="pb note">{FLIGHT_NO_SEAT}</p>
      ) : (
        <div className="pb briefgrid">
          {view.sections.map((s) => (
            <section className="briefsec" key={s.section} data-testid="brief-section">
              <h3>{s.title}</h3>
              <span className="s fg2">{briefUpdated(s.updatedAt, now, tz)}</span>
              {s.text.trim() === "" ? (
                <p className="note">{BRIEF_EMPTY}</p>
              ) : (
                <div className="md-txt">
                  <Markdown text={s.text} />
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Situation's paragraph, from the brief. */
export function SituationText() {
  const view = useBrief();
  if (view === undefined) return <p className="sittext note">{DASH}</p>;
  if (view.session === null) return <p className="sittext note">{FLIGHT_NO_SEAT}</p>;
  const text = situationText(view);
  if (text === "") return <p className="sittext note">{SITUATION_EMPTY}</p>;
  return (
    <div className="sittext">
      <Markdown text={text} />
    </div>
  );
}

function WatchRow({ entry, seatId }: { entry: FlightWatchEntry; seatId?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = entry.action;
  const activate = async () => {
    if (action?.kind === "draft") {
      const row = document.getElementById(draftRowId(action.draftId, action.target));
      row?.scrollIntoView?.({ block: "nearest" });
      row?.focus();
    } else if (action?.kind === "lock-hold" && seatId) {
      setBusy(true);
      setError(null);
      try {
        await apiPost(ACTIONS.seatEnd(seatId), {
          watch: {
            id: entry.id,
            runId: action.runId,
            toolUseId: action.toolUseId,
            since: action.since,
          },
        });
        hub.refetchTopic("guard");
        hub.refetchTopic("agents");
        hub.refetchTopic("flight");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    }
  };
  return (
    <li className="watch-row">
      <i
        className={`lamp ${entry.state}${entry.state === "warn" ? " pulse" : ""}`}
        role="img"
        aria-label={entry.state}
      />
      <div className="min0">
        <b>{entry.title}</b>
        <div className="s fg2">{entry.detail}</div>
        <div className="row s fg2">
          <Pill tone={entry.catchUp.kind === "new" ? "plain" : "warn"}>
            {CATCH_UP_LABEL[entry.catchUp.kind]}
          </Pill>
          <span>{entry.catchUp.line}</span>
        </div>
        <div className="row s">
          <span>Next: {entry.next}</span>
          {(action?.kind === "draft" || (action?.kind === "lock-hold" && seatId)) && (
            <button
              type="button"
              className={action.kind === "lock-hold" ? "sm warn" : "sm"}
              disabled={busy}
              onClick={() => void activate()}
            >
              {action.kind === "draft" ? "See draft" : "Stop the run"}
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="note err">
            {error}
          </p>
        )}
      </div>
    </li>
  );
}

/** Structured watch entries; risks stay in the living brief. */
export function WatchList() {
  const { data: view, error } = useResource<FlightBriefView>(RESOURCES.flightBrief);
  const lock = useResource<TestLockState>(RESOURCES.testLock).data;
  const crew = useResource<{ rows: CrewRow[] }>(RESOURCES.crew).data;
  if (error)
    return (
      <p className="pb note err" role="alert">
        {error.message}
      </p>
    );
  if (view === undefined) return <p className="pb note">{DASH}</p>;
  if (view.session === null) return <p className="pb note">{FLIGHT_NO_SEAT}</p>;
  const holder = lock?.holder;
  const blocked =
    holder &&
    lock.waiting.length > 0 &&
    crew?.rows.some((r) => r.id === holder.seatId && r.hudState === "stalled");
  const entries = (view.watch ?? []).filter(
    (entry) =>
      entry.action?.kind !== "lock-hold" ||
      (blocked && entry.action.runId === holder.runId && entry.action.since === holder.since),
  );
  if (!entries.length) return <p className="pb note">{WATCH_EMPTY}</p>;
  return (
    <ul className="pb tlist" aria-label="Watch list">
      {entries.map((entry) => (
        <WatchRow key={entry.id} entry={entry} seatId={holder?.seatId} />
      ))}
    </ul>
  );
}
