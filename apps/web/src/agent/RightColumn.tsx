import type { AgentDetailView, CrewRow, LiveTask, RunView } from "@mc/core";
import { useState } from "react";
import { useNow, useTz } from "../clock.ts";
import { hasActiveRun, modelLine, seatAreaText } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { dur, hhmm } from "../fmt.ts";
import { Seg } from "../hud/Seg.tsx";
import { SeatInstructionsDisclosure } from "../instructions/Instructions.tsx";
import { followLink, setupPath, tracePath } from "../router.ts";
import { planProgress, runOutcome } from "./control.ts";
import { HandoffPanel } from "./HandoffPanel.tsx";
import { usePlan } from "./plan.ts";
import { RunsPanel } from "./RunsPanel.tsx";
import { Queue } from "./SideTabs.tsx";

const RECENT_RUNS = 5;

/** What the seat waits for, since when, with a link. */
function WaitingOn({ view }: { view: AgentDetailView }) {
  const now = useNow();
  const { awaiting, nextMove } = view;
  const waiting =
    view.row.hudState === "waiting" ||
    view.row.hudState === "blocked" ||
    view.row.hudState === "parked" ||
    nextMove !== null;
  return (
    <section className="panel side-waiting" aria-label="Waiting on">
      <h3>Waiting on</h3>
      {waiting ? (
        <>
          <p>
            <b>{awaiting.label}</b>
            {awaiting.reason ? `: ${awaiting.reason}` : ""}
            {awaiting.since !== null && (
              <span className="muted"> · since {dur(Math.max(0, now - awaiting.since))} ago</span>
            )}
          </p>
          {nextMove && (
            <a href={nextMove.href} onClick={(e) => followLink(e, nextMove.href)}>
              {nextMove.label}
            </a>
          )}
        </>
      ) : (
        <p className="muted">Nothing. It is not waiting on anyone.</p>
      )}
    </section>
  );
}

/** Tickets the seat has open and is not working on; gone once a seat holds one ticket. */
function AlsoOpen({ row }: { row: CrewRow }) {
  const queue = row.queue ?? [];
  const aside = row.asideRuns ?? [];
  if (queue.length === 0 && aside.length === 0) return null;
  return (
    <section className="panel side-open" aria-label="Also open">
      <h3>Also open</h3>
      <ul>
        {aside.map((a) => (
          <li key={a.runId}>
            <span className="mono">{a.ticket ?? a.runId}</span> {a.ticketTitle ?? ""}{" "}
            <span className="muted">{a.loop.text}</span>
          </li>
        ))}
        {queue.map((q) => (
          <li key={q.ref}>
            <span className="mono">{q.ref}</span> <span className="muted">next up, {q.pos}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlanTab({ tasks }: { tasks: readonly LiveTask[] }) {
  return (
    <ul className="plan-list">
      {tasks.map((t) => (
        <li key={t.id} className={t.status}>
          <span aria-hidden="true">
            {t.status === "done" ? "✓" : t.status === "in_progress" ? "◌" : "·"}
          </span>{" "}
          <span className="sr-only">
            {t.status === "done" ? "done: " : t.status === "in_progress" ? "doing: " : "to do: "}
          </span>
          {t.text}
        </li>
      ))}
    </ul>
  );
}

function RunsTab({ row }: { row: CrewRow }) {
  const tz = useTz();
  const [historyOpen, setHistoryOpen] = useState(false);
  const runs = useResource<RunView[]>(RESOURCES.runs(row.id));
  if (!runs.data)
    return runs.error ? (
      <p className="crit-t">Could not load the runs: {runs.error.message}</p>
    ) : (
      <p className="muted">Loading…</p>
    );
  const list = [...runs.data].sort((a, b) => b.startedAt - a.startedAt).slice(0, RECENT_RUNS);
  const history = row.run && (
    <>
      {row.loop && (
        <a
          className="runs-trace"
          href={tracePath(row.id, row.run.id)}
          onClick={(e) => followLink(e, tracePath(row.id, row.run?.id ?? ""))}
        >
          Open run trace
        </a>
      )}
      {row.kind === "crew" && <HandoffPanel runId={row.run.id} />}
      <details
        className="runs-history"
        onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
      >
        <summary>Attempts and previous runs</summary>
        {historyOpen && <RunsPanel key={`r:${row.id}`} row={row} tz={tz} />}
      </details>
    </>
  );
  if (list.length === 0)
    return (
      <>
        <p className="muted">No runs yet.</p>
        {history}
      </>
    );
  return (
    <>
      <ul className="runs-list">
        {list.map((r) => {
          const out = runOutcome(r);
          const to = tracePath(row.id, r.id);
          return (
            <li key={r.id}>
              <a href={to} onClick={(e) => followLink(e, to)}>
                <span className="mono">{r.ticket ?? `run ${r.seq}`}</span> {r.ticketTitle ?? ""}
              </a>
              <span className="muted">
                {" "}
                · {out.word} · {r.endedAt !== null ? dur(r.endedAt - r.startedAt) : "running"}
                {tz ? ` · ${hhmm(r.startedAt, tz)}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
      {history}
    </>
  );
}

function SetupTab({ row }: { row: CrewRow }) {
  return (
    <dl className="setup-list">
      <dt>Repo</dt>
      <dd>{row.repoId}</dd>
      <dt>Role</dt>
      <dd>{row.role ?? "observed loop"}</dd>
      <dt>Model</dt>
      <dd>
        {modelLine(row)}
        {row.cli.effort ? ` · effort ${row.cli.effort}` : ""}
      </dd>
      <dt>Account</dt>
      <dd>{row.accountId}</dd>
      <dt>May change</dt>
      <dd>{seatAreaText(row)}</dd>
      <dd>
        <a href={setupPath("roles")} onClick={(e) => followLink(e, setupPath("roles"))}>
          Role prompt
        </a>{" "}
        ·{" "}
        <a href={setupPath("sessions")} onClick={(e) => followLink(e, setupPath("sessions"))}>
          Edit in Setup
        </a>
      </dd>
      {row.kind === "crew" && row.mode === "writer" && (
        <dd className="setup-queue">
          <h4>Queue and focus</h4>
          <Queue key={`queue:${row.id}`} row={row} />
        </dd>
      )}
      {row.kind === "crew" && (
        <dd className="setup-instructions">
          <SeatInstructionsDisclosure key={`instructions:${row.id}`} seatId={row.id} />
        </dd>
      )}
    </dl>
  );
}

type Tab = "plan" | "runs" | "setup";

/** The right column: what the seat waits on, its other tickets, and Plan, Recent runs and Setup. */
export function RightColumn({ view }: { view: AgentDetailView }) {
  const { row } = view;
  const tasks = usePlan(row);
  const hasPlan = planProgress(tasks) !== null;
  const inRun = hasActiveRun(row);
  const [picked, setPicked] = useState<{ seat: string; tab: Tab } | null>(null);
  const fallback: Tab = hasPlan && inRun ? "plan" : "runs";
  const tab: Tab =
    picked && picked.seat === row.id && (picked.tab !== "plan" || hasPlan) ? picked.tab : fallback;
  const options = [
    ...(hasPlan ? [{ value: "plan" as const, label: "Plan" }] : []),
    { value: "runs" as const, label: "Recent runs" },
    { value: "setup" as const, label: "Setup" },
  ];
  return (
    <div className="side">
      <WaitingOn view={view} />
      <AlsoOpen row={row} />
      <section className="panel side-tabs" aria-label="Plan, recent runs and setup">
        <div className="ph">
          <Seg
            label="Seat details"
            options={options}
            value={tab}
            onChange={(t) => setPicked({ seat: row.id, tab: t })}
          />
        </div>
        <div className="pb side-body">
          {tab === "plan" && <PlanTab tasks={tasks} />}
          {tab === "runs" && <RunsTab row={row} />}
          {tab === "setup" && <SetupTab row={row} />}
        </div>
      </section>
    </div>
  );
}
