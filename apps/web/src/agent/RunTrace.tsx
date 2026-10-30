import type { LoopTry, RunLoopView, RunView } from "@mc/core";
import { Expandable } from "../components/Expandable.tsx";
import { LOOP_PATH, LOOP_PHASE_LABEL } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { dur } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { agentPath, followLink } from "../router.ts";
import { reasonLine, runLimits, stepTokens, tokenText, tryClass, tryMinutes } from "./loopView.ts";

type LoopStep = (typeof LOOP_PATH)[number];
const stepLabel = (step: LoopStep): string => (step === "ci" ? "Checks" : LOOP_PHASE_LABEL[step]);
const allTokens = (tries: readonly LoopTry[]): number | null => stepTokens(tries);

const routeAfter = (step: LoopStep, outcome: LoopTry["outcome"]): LoopStep | null => {
  if (outcome === "parked" || outcome === "stopped") return null;
  if (step === "working") return "ci";
  if (step === "ci") return outcome === "pass" ? "review" : outcome === "fail" ? "working" : null;
  if (step === "review") return outcome === "pass" ? "done" : outcome === "fail" ? "working" : null;
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

/** A visit's outcome and its reason as one line; the whole text opens on a click. */
function VisitNote({ visit }: { visit: LoopTry }) {
  if (!visit.reason) return <span className="run-checklist-note">{visit.outcome}</span>;
  const { line, full } = reasonLine(visit.reason);
  const text = `${visit.outcome}: ${line}`;
  if (full === null) return <span className="run-checklist-note">{text}</span>;
  return (
    <span className="run-checklist-note">
      <Expandable summary={text}>
        <span className="run-checklist-full">{full}</span>
      </Expandable>
    </span>
  );
}

/**
 * A run event as one line. Each recorded reason inside it is cut to its line (its visit holds the
 * whole); any other long text keeps its whole in `full`, for a disclosure.
 */
const eventLine = (text: string, tries: readonly LoopTry[]): ReasonLine => {
  let shown = text;
  for (const { reason } of tries) {
    if (reason) shown = shown.split(reason).join(reasonLine(reason).line);
  }
  return reasonLine(shown);
};

/** A compact history: every recorded try is a visit, so a return is never hidden in an aggregate. */
export function RunChecklist({ view, now }: { view: RunLoopView; now: number }) {
  const tries = Array.isArray(view.tries) ? view.tries : [];
  const total = allTokens(tries);
  const first = tries[0];
  const last = tries.at(-1);
  const elapsed =
    first && last ? Math.round(((last.endedAt ?? now) - first.startedAt) / 60_000) : 0;
  if (tries.length === 0) return <p className="s muted">No loop steps recorded yet.</p>;
  return (
    <ol className="run-checklist">
      {visits(tries).map((visit) => (
        <li key={`${visit.step}:${visit.fix ? "fix" : "try"}:${visit.n}:${visit.startedAt}`}>
          <span className={tryClass(visit)}>{visit.outcome === "pass" ? "✓" : "●"}</span>
          <span>
            <b>{stepLabel(visit.step)}</b>
            <VisitNote visit={visit} />
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
  const limits = run ? runLimits(run) : null;
  return (
    <section className="trace-section">
      <h2>Stop rules</h2>
      <p>
        CI fixes {ciFails} / {limits?.tries ?? "unavailable"}
      </p>
      <p>
        Review round {round} / {limits?.rounds ?? "unavailable"}
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
  const held = current.outcome === "parked" || current.outcome === "stopped";
  const next = routeAfter(current.step, current.outcome);
  const conditional =
    (current.outcome === "running" || current.outcome === "waiting") &&
    (current.step === "ci" || current.step === "review");
  const limits = run ? runLimits(run) : null;
  return (
    <section className="trace-section">
      <h2>Next</h2>
      <p>
        {held
          ? `${stepLabel(current.step)} ${current.outcome}${current.reason ? `: ${reasonLine(current.reason).line}` : ""}.`
          : conditional
            ? `If ${stepLabel(current.step)} pass → ${stepLabel(routeAfter(current.step, "pass") as LoopStep)}; if it fails → Working${current.step === "ci" ? (limits ? ` (CI fix ${Math.min((view.loop?.ciFails ?? 0) + 1, limits.tries)} of ${limits.tries})` : " (CI cap unavailable)") : ""}.`
            : next
              ? current.outcome === "running" || current.outcome === "waiting"
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
        <div className="trace-main">
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
            {view.review && <p className="s muted">{view.review.description}</p>}
          </section>
          {view.events.length > 0 && (
            <section className="trace-section">
              <h2>Run events</h2>
              {view.events.map((event) => {
                const { line, full } = eventLine(event.text, view.tries);
                return (
                  <p key={event.key}>
                    {full === null ? (
                      line
                    ) : (
                      <Expandable summary={line}>
                        <span className="run-checklist-full">{full}</span>
                      </Expandable>
                    )}
                  </p>
                );
              })}
            </section>
          )}
        </div>
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
      className="trace-panel"
      title="Run Trace"
      actions={
        <a href={to} onClick={(e) => followLink(e, to)}>
          Back to agent
        </a>
      }
    >
      <div className="pb scroll">
        <RunTrace
          runId={runId}
          view={loop.data}
          startedAt={startedAt}
          endedAt={endedAt}
          now={Date.now()}
          run={run}
        />
      </div>
    </Panel>
  );
}
