import {
  type CrewRow,
  FLIGHT_NOTE_SECTIONS,
  type FlightBriefView,
  type FlightWatchEntry,
  type TestLockState,
} from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { useSecond, useTz } from "../clock.ts";
import { Expandable } from "../components/Expandable.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { rel } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { CATCH_UP_LABEL } from "../notifications.ts";
import { draftRowId } from "./Drafts.tsx";
import { FLIGHT_NO_SEAT } from "./flightTypes.ts";
import { Pending } from "./Pending.tsx";

const DASH = "—";
export const BRIEF_EMPTY = "Nothing here yet.";
export const WATCH_EMPTY = "FLIGHT is not watching anything yet.";

/** When a section was last changed: "never updated", "updated —" until the timezone is known. */
export function briefUpdated(at: number | null, now: number, tz: string | null): string {
  if (at === null) return "never updated";
  return tz === null ? `updated ${DASH}` : `updated ${rel(at, now, tz)}`;
}

/** FLIGHT's brief as the hub holds it; undefined until it loads. */
export const useBrief = (): FlightBriefView | undefined =>
  useResource<FlightBriefView>(RESOURCES.flightBrief).data;

/** FLIGHT's writable working-context notes, as rendered Markdown and exact stored source. */
export function BriefPanel({ expanded = false }: { expanded?: boolean }) {
  const view = useBrief();
  const briefError = useResource<FlightBriefView>(RESOURCES.flightBrief).error;
  const now = useSecond();
  const tz = useTz();
  const writable: readonly string[] = FLIGHT_NOTE_SECTIONS;
  const sections = view?.sections.filter((section) => writable.includes(section.section)) ?? [];
  // The newest of the sections, so the collapsed panel says how old the context is.
  const updatedAt = sections.reduce<number | null>(
    (latest, s) => (s.updatedAt !== null && s.updatedAt > (latest ?? 0) ? s.updatedAt : latest),
    null,
  );
  const content = (
    <>
      <p className="pb note">
        Live Markdown from the hub · the same working context FLIGHT reads and updates
      </p>
      {view === undefined ? (
        <Pending what="working context" error={briefError} resource={RESOURCES.flightBrief} />
      ) : view.session === null ? (
        <p className="pb note">{FLIGHT_NO_SEAT}</p>
      ) : (
        <>
          <p className="pb note flight-notebook-horizons">
            Two horizons: working context is FLIGHT's current view of this session, rewritten as it
            changes; durable knowledge is sourced repo memory that outlasts it.
          </p>
          <nav className="flight-notebook-index" aria-label="Notebook sections">
            {sections.map((s) => (
              <a key={s.section} href={`#flight-note-${s.section}`}>
                {s.title}
              </a>
            ))}
            <a href="#memoryP">Durable knowledge</a>
          </nav>
          <div className="pb briefgrid">
            {sections.map((s) => (
              <section
                className="briefsec"
                id={`flight-note-${s.section}`}
                key={s.section}
                data-testid="brief-section"
              >
                <div className="flight-note-heading">
                  <h3>
                    <a href={`#flight-note-${s.section}`}>{s.title}</a>
                  </h3>
                  <span className="s fg2">
                    FLIGHT{`${s.updatedBy ? ` · ${s.updatedBy}` : ""}`} ·{" "}
                    {briefUpdated(s.updatedAt, now, tz)}
                  </span>
                </div>
                {s.text.trim() === "" ? (
                  <p className="note">{BRIEF_EMPTY}</p>
                ) : (
                  <>
                    <div className="md-txt">
                      <Markdown text={s.text} />
                    </div>
                    <details className="flight-markdown-source">
                      <summary>Markdown source</summary>
                      <pre>{s.text}</pre>
                    </details>
                  </>
                )}
              </section>
            ))}
          </div>
        </>
      )}
    </>
  );
  return expanded ? (
    <Panel
      id="briefP"
      className="flight-notes"
      title="Working context"
      sub="project, crew, operator and lessons · live Markdown authored by FLIGHT"
    >
      <div className="flight-knowledge-scroll">{content}</div>
    </Panel>
  ) : (
    <section className="panel flight-notes" id="briefP" aria-label="FLIGHT's notes">
      <Expandable
        summary={
          <>
            <h2>FLIGHT's notes</h2>
            {updatedAt !== null && (
              <span className="s fg2">{` · updated ${briefUpdated(updatedAt, now, tz)}`}</span>
            )}
          </>
        }
      >
        {content}
      </Expandable>
    </section>
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
  if (view === undefined)
    return <Pending what="revisit triggers" error={null} resource={RESOURCES.flightBrief} />;
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
