import type { LoopTry, RunLoopView, RunView } from "@mc/core";
import { LOOP_PATH, LOOP_PHASE_LABEL } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { dur } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { agentPath, followLink } from "../router.ts";
import { runLimits, stepTokens, tokenText, tryClass, tryMinutes, tryText } from "./loopView.ts";

type LoopStep = (typeof LOOP_PATH)[number];
const stepLabel = (step: LoopStep): string => (step === "ci" ? "Checks" : LOOP_PHASE_LABEL[step]);
const allTokens = (tries: readonly LoopTry[]): number | null => stepTokens(tries);

const routeAfter = (step: LoopStep, outcome: LoopTry["outcome"]): LoopStep | null => {
  if (step === "working") return "ci";
  if (step === "ci") return outcome === "fail" ? "working" : "review";
  if (step === "review") return outcome === "fail" ? "working" : "done";
  return null;
};

type Visit = LoopTry & { next: LoopStep | null };
const visits = (tries: readonly LoopTry[]): Visit[] =>
  tries.map((try_, i) => ({
    ...try_,
    next: tries[i + 1]?.step ?? routeAfter(try_.step, try_.outcome),
  }));

const edgeCounts = (tries: readonly LoopTry[]): readonly [string, number][] => {
  const counts = new Map<string, number>();
  for (let i = 0; i < tries.length - 1; i++) {
    const edge = `${stepLabel(tries[i].step)} → ${stepLabel(tries[i + 1].step)}`;
    counts.set(edge, (counts.get(edge) ?? 0) + 1);
  }
  return [...counts];
};

/** A compact history: every recorded try is a visit, so a return is never hidden in an aggregate. */
export function RunChecklist({ view, now }: { view: RunLoopView; now: number }) {
  const total = allTokens(view.tries);
  const first = view.tries[0];
  const last = view.tries.at(-1);
  const elapsed =
    first && last ? Math.round(((last.endedAt ?? now) - first.startedAt) / 60_000) : 0;
  if (view.tries.length === 0) return <p className="s muted">No loop steps recorded yet.</p>;
  return (
    <ol className="run-checklist">
      {visits(view.tries).map((visit) => (
        <li key={`${visit.step}:${visit.fix ? "fix" : "try"}:${visit.n}:${visit.startedAt}`}>
          <span className={tryClass(visit)}>{visit.outcome === "pass" ? "✓" : "●"}</span>
          <span>
            <b>{stepLabel(visit.step)}</b>
            <span className="run-checklist-note">{tryText(visit)}</span>
          </span>
          <span className="num muted">
            {tokenText(visit.tokens)} · {tryMinutes(visit, now)}m
            {visit.next && (
              <span className="run-checklist-next">Next: {stepLabel(visit.next)}</span>
            )}
          </span>
        </li>
      ))}
      <li className="run-checklist-total">
        <span />
        <span>Loop total</span>
        <span>
          {tokenText(total)} tokens total · {elapsed}m
        </span>
      </li>
    </ol>
  );
}

function StopRules({ view, run }: { view: RunLoopView; run?: RunView }) {
  const ciFails = view.loop?.ciFails ?? 0;
  const round = view.round ?? 0;
  const limits = runLimits(run);
  return (
    <section className="trace-section">
      <h2>Stop rules</h2>
      <p>
        CI fixes {ciFails} / {limits.tries}
      </p>
      <p>
        Rework rounds {round} / {limits.rounds}
      </p>
      {view.budget !== null && (
        <p>
          Tokens {tokenText(allTokens(view.tries))} / {tokenText(view.budget)}
        </p>
      )}
    </section>
  );
}

function Next({ view, run }: { view: RunLoopView; run?: RunView }) {
  const current = view.tries.at(-1);
  if (!current) return null;
  const next = routeAfter(current.step, current.outcome);
  const conditional =
    current.outcome === "running" && (current.step === "ci" || current.step === "review");
  const limits = runLimits(run);
  return (
    <section className="trace-section">
      <h2>Next</h2>
      <p>
        {conditional
          ? `If ${stepLabel(current.step)} pass → ${stepLabel(routeAfter(current.step, "pass") as LoopStep)}; if it fails → Working${current.step === "ci" ? ` (CI fix ${Math.min((view.loop?.ciFails ?? 0) + 1, limits.tries)} of ${limits.tries})` : ""}.`
          : next
            ? current.outcome === "running"
              ? `${stepLabel(current.step)} → ${stepLabel(next)}`
              : `If ${stepLabel(current.step)} ${current.outcome === "pass" ? "passes" : "fails"} → ${stepLabel(next)}`
            : "Waiting for the next recorded loop step."}
      </p>
    </section>
  );
}

/** Full operator trace for one recorded run. */
export function RunTrace({
  runId,
  view,
  startedAt,
  endedAt,
  now,
  run,
}: {
  runId: string;
  view: RunLoopView;
  startedAt: number;
  endedAt: number | null;
  now: number;
  run?: RunView;
}) {
  const elapsed = Math.max(0, (endedAt ?? now) - startedAt);
  const byStep = LOOP_PATH.flatMap((step) => {
    const tokens = stepTokens(view.tries.filter((try_) => try_.step === step));
    return tokens === null ? [] : [[step, tokens] as const];
  });
  return (
    <section className="run-trace">
      <div className="trace-head">
        <div>
          <p className="eyebrow">AGENT / RUN TRACE</p>
          <h1>Run Trace</h1>
          <p className="muted">
            {runId} · elapsed {dur(elapsed)} · {tokenText(allTokens(view.tries))} tokens
          </p>
        </div>
      </div>
      <div className="trace-grid">
        <main>
          <section className="trace-section">
            <h2>Loop edges</h2>
            {edgeCounts(view.tries).length ? (
              edgeCounts(view.tries).map(([edge, count]) => (
                <p key={edge}>
                  {edge} ×{count}
                </p>
              ))
            ) : (
              <p className="muted">No transitions recorded yet.</p>
            )}
          </section>
          <section className="trace-section">
            <h2>Step-by-step timeline</h2>
            <RunChecklist view={view} now={now} />
          </section>
          {view.events.length > 0 && (
            <section className="trace-section">
              <h2>Run events</h2>
              {view.events.map((event) => (
                <p key={event.key}>{event.text}</p>
              ))}
            </section>
          )}
        </main>
        <aside>
          <section className="trace-section">
            <h2>Where the tokens go</h2>
            {byStep.length ? (
              byStep.map(([step, tokens]) => (
                <p key={step}>
                  {stepLabel(step)} · {tokenText(tokens)}
                </p>
              ))
            ) : (
              <p className="muted">No measured token usage yet.</p>
            )}
          </section>
          <StopRules view={view} run={run} />
          <Next view={view} run={run} />
        </aside>
      </div>
    </section>
  );
}

/** Fetches the selected run's independent loop record for the Agent-page trace mode. */
export function RunTracePanel({ agentId, runId }: { agentId: string; runId: string }) {
  const loop = useResource<RunLoopView>(RESOURCES.runLoop(runId));
  const runs = useResource<RunView[]>(RESOURCES.runs(agentId));
  const run = runs.data?.find((candidate) => candidate.id === runId);
  if (loop.error && !loop.data)
    return <p className="crit-t s">Could not load the run trace: {loop.error.message}</p>;
  if (!loop.data) return <p className="s muted">Loading run trace…</p>;
  const startedAt = run?.startedAt ?? loop.data.tries[0]?.startedAt;
  if (startedAt === undefined) return <p className="s muted">No loop steps recorded yet.</p>;
  const endedAt = run?.endedAt ?? loop.data.tries.at(-1)?.endedAt ?? null;
  const to = agentPath(agentId);
  return (
    <Panel
      title="Run Trace"
      actions={
        <a href={to} onClick={(e) => followLink(e, to)}>
          Back to agent
        </a>
      }
    >
      <RunTrace
        runId={runId}
        view={loop.data}
        startedAt={startedAt}
        endedAt={endedAt}
        now={Date.now()}
        run={run}
      />
    </Panel>
  );
}
