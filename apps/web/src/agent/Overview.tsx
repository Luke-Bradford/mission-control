import type { AgentDetailView } from "@mc/core";
import { type MouseEvent, useRef } from "react";
import { useNow } from "../clock.ts";
import { callSign, modelLine, seatAreaText } from "../crew.ts";
import { cost, dur, firstLine, kTokens, percent } from "../fmt.ts";
import { useRoleLabel } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { PromptCostBar } from "../hud/PromptCost.tsx";
import { ReviewCheck } from "../hud/ReviewState.tsx";
import { followLink, tracePath } from "../router.ts";
import { AgentHeaderActions, HeaderReviewState } from "./Header.tsx";
import { ListScrollCue } from "./ListScrollCue.tsx";
import { Reason } from "./Reason.tsx";
import "./Overview.css";

const DASH = "—";
const localLink = (event: MouseEvent<HTMLAnchorElement>) =>
  followLink(event, event.currentTarget.getAttribute("href") ?? "/agent");
function BriefReason({ text, limit, label }: { text: string; limit: number; label: string }) {
  const line = firstLine(text).slice(0, limit);
  const abbreviated = line !== text;
  return (
    <Reason
      line={abbreviated ? `${line.trimEnd()}…` : line}
      full={abbreviated ? text : null}
      label={label}
    />
  );
}
function Age({ at }: { at: number }) {
  const now = useNow();
  return <span className="mono muted">State changed {dur(Math.max(0, now - at))} ago</span>;
}
function StepAge({ since }: { since: number }) {
  const now = useNow();
  return <span>{dur(Math.max(0, now - since))} in this step</span>;
}
export function AgentIdentity({ view }: { view: AgentDetailView }) {
  const { row, awaiting } = view;
  const role = useRoleLabel(row.id);
  const reason = awaiting.reason,
    short = reason ? firstLine(reason).slice(0, 140) : null;
  return (
    <section className="panel agent-v2-identity" id="ahead" aria-label={`${row.id} details`}>
      <div className="agent-v2-idrow">
        <h2 title={role.title}>
          <i aria-hidden="true" style={{ background: `var(--seat-${(row.index % 7) + 1})` }} />
          {callSign(row)}
          {role.suffix !== null && <span className="rt">{` · ${role.suffix}`}</span>}
        </h2>
        <span className={`agent-v2-state ${awaiting.label === "Parked" ? "parked" : row.hudState}`}>
          <b>{awaiting.label}</b>
          {short && (
            <>
              {" "}
              · <Reason line={short} full={reason !== short ? reason : null} />
            </>
          )}
        </span>
        {row.review?.check &&
          !row.crewPause &&
          row.hudState !== "stopped" &&
          row.hudState !== "error" && <HeaderReviewState check={row.review.check} />}
        <AgentHeaderActions key={row.id} row={row} />
      </div>
      <div className="agent-v2-meta">
        {view.story.ticketHref && (
          <a href={view.story.ticketHref} onClick={localLink}>
            {row.ticket}
          </a>
        )}
        <b>{row.ticketTitle ?? (row.kind === "loop" ? "Observed loop" : "No ticket assigned")}</b>
        {row.run?.branch && <span className="mono">{row.run.branch}</span>}
        {awaiting.since === null ? (
          <span className="muted">State change not recorded</span>
        ) : (
          <Age at={awaiting.since} />
        )}
      </div>
      <p className="s fg2 chips">
        {row.kind === "crew"
          ? `${row.role} · ${row.mode} · s/${row.sessionId}`
          : `observed loop · ${row.loopKind}`}{" "}
        · {row.accountId} · {modelLine(row)}
        {row.kind === "crew" ? ` · area: ${seatAreaText(row)}` : ""}
      </p>
    </section>
  );
}
export function AgentNextMove({ view }: { view: AgentDetailView }) {
  const move = view.nextMove;
  if (!move) return null;
  const title =
    move.owner === "operator"
      ? "Your next move"
      : move.owner === "flight"
        ? "Waiting on FLIGHT"
        : move.owner === "controller"
          ? "For the controller"
          : move.owner === "loop"
            ? "For this loop"
            : `Waiting on ${move.owner.slice(5)}`;
  return (
    <section className="panel agent-v2-next" aria-label="Next move">
      <b>{title}</b>
      <div>
        <BriefReason text={move.text} limit={160} label="next decision" />
        {move.recommendation && <p className="s fg2">FLIGHT recommends: {move.recommendation}</p>}
      </div>
      <a className="btn" href={move.href} onClick={localLink}>
        {move.label}
      </a>
    </section>
  );
}
/** Seat availability and queued work are separate: stopped seats can still have a review waiting. */
export function AgentAvailability({ view }: { view: AgentDetailView }) {
  const { row, awaiting } = view;
  const queued = row.queuedReview;
  const checking = row.reviewing;
  return (
    <Panel title="What is happening now?">
      <div className="pb agent-v2-availability">
        <div className="agent-v2-awaiting">
          <b>{awaiting.label}</b>
          {awaiting.reason && (
            <BriefReason text={awaiting.reason} limit={200} label="current state reason" />
          )}
        </div>
        {row.sourceError && <p className="crit-t">Source could not refresh: {row.sourceError}</p>}
        {row.mode === "writer" && row.review && (
          <p className="s muted">PR #{row.review.prNumber} · head SHA not supplied in this view</p>
        )}
        {checking && (
          <p>
            {row.crewPause || row.paused || row.hudState === "stopped" || row.hudState === "error"
              ? "Assigned review"
              : "Checking"}{" "}
            PR #{checking.prNumber} · <code>{checking.sha}</code>
            {checking.ref ? ` · ${checking.ref}` : ""}
          </p>
        )}
        {queued && (
          <div className="agent-v2-queued-review">
            <b>
              Review waiting · PR #{queued.prNumber} · #{queued.position} in queue
            </b>
            <p>{queued.reason}</p>
            <p>
              Queued head <code>{queued.sha}</code>
              {queued.ref ? ` · ${queued.ref}` : ""}
            </p>
            <a
              href={`/qa?repo=${encodeURIComponent(queued.repoId)}&pr=${queued.prNumber}&head=${encodeURIComponent(queued.sha)}`}
              onClick={localLink}
            >
              Review evidence for this head
            </a>
          </div>
        )}
        {row.review?.check && <ReviewCheck check={row.review.check} />}
      </div>
    </Panel>
  );
}
export function AgentStats({ view }: { view: AgentDetailView }) {
  const { row, health, tools, context } = view;
  if (!row.run)
    return (
      <p className="pb s muted">
        No run yet.{" "}
        <a href="/board" onClick={localLink}>
          Open the board
        </a>{" "}
        to see the work.
      </p>
    );
  const tokens = row.run.tokens;
  return (
    <section className="agent-v2-stats" aria-label="Run figures">
      <Stat label="Run health" value={health.label}>
        <span>
          {health.blocking === null
            ? "Review verdict not recorded"
            : `${health.blocking} blocking review findings`}
        </span>
        <span>Current PR head</span>
      </Stat>
      <Stat label="Tools this run" value={tools.total === null ? DASH : String(tools.total)}>
        <span>
          {tools.failed === null ? "Failures not recorded" : `${tools.failed} failed calls`}
        </span>
        <span>
          {tools.byTool
            .slice(0, 3)
            .map((t) => `${t.name} ${t.calls}`)
            .join(" · ") || "No tool calls recorded"}
        </span>
      </Stat>
      <Stat label="Tokens this run" value={tokens ? kTokens(tokens.input + tokens.output) : DASH}>
        <span>
          {tokens
            ? `${kTokens(tokens.input)} in · ${kTokens(tokens.output)} out`
            : "Usage not recorded"}
        </span>
        <span>Reported usage</span>
      </Stat>
      <Stat label="Cost this run" value={cost(view.cost.totalUsd)}>
        <span>Mean {cost(view.cost.meanPerReportedTurnUsd)} per reported turn</span>
        <span>API equivalent · {view.cost.turns ?? DASH} turns</span>
      </Stat>
      <Stat label="Context now" value={context.percent === null ? DASH : percent(context.percent)}>
        <span>
          {context.window === null ? "Window not recorded" : `of ${kTokens(context.window)} tokens`}
        </span>
        <span>
          {context.tokens === null
            ? "Used tokens not recorded"
            : `${kTokens(context.tokens)} tokens used`}{" "}
          · latest saved reading
        </span>
      </Stat>
    </section>
  );
}
function Stat({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel agent-v2-stat">
      <h3>{label}</h3>
      <p>{value}</p>
      <div>{children}</div>
    </section>
  );
}
export function AgentLoop({ view }: { view: AgentDetailView }) {
  const steps = useRef<HTMLOListElement>(null);
  if (!view.row.run) return null;
  return (
    <Panel
      title="Build loop"
      sub={view.row.loop?.profile ?? undefined}
      actions={
        <a href={tracePath(view.row.id, view.row.run.id)} onClick={localLink}>
          Open run trace
        </a>
      }
    >
      {view.steps.length ? (
        <>
          <ListScrollCue region={steps} label="loop steps" count={view.steps.length} />
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded steps scroll with the keyboard. */}
          <ol className="agent-v2-steps" ref={steps} tabIndex={0} aria-label="Build loop steps">
            {view.steps.map((step) => (
              <li key={step.id} className={step.state}>
                <b>
                  {step.state === "done"
                    ? "✓"
                    : step.state === "held"
                      ? "Ⅱ"
                      : step.state === "current"
                        ? "●"
                        : "○"}{" "}
                  {step.label}
                </b>
                <span>
                  {step.state === "unknown"
                    ? "Not recorded"
                    : step.state === "todo"
                      ? "Not started"
                      : step.state === "done"
                        ? "Completed"
                        : step.state === "held"
                          ? "Held"
                          : "Running"}
                  {step.tries !== null
                    ? ` · ${step.tries} ${step.failures !== null ? "executions" : step.limit !== null ? "rounds" : step.tries === 1 ? "try" : "tries"}${step.failures === null && step.limit !== null ? ` of ${step.limit}` : ""}`
                    : " · tries not recorded"}
                  {step.failures !== null &&
                    ` · ${step.failures} ${step.failures === 1 ? "failure" : "failures"}${step.limit !== null ? ` of ${step.limit} allowed` : ""}`}
                </span>
                <span className="agent-v2-step-time">
                  {step.since !== null ? (
                    <StepAge since={step.since} />
                  ) : step.durationMs !== null ? (
                    dur(step.durationMs)
                  ) : (
                    DASH
                  )}
                </span>
                {step.reason && (
                  <BriefReason text={step.reason} limit={100} label={`${step.label} reason`} />
                )}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="pb s muted">No build loop is recorded for this run.</p>
      )}
    </Panel>
  );
}
export function AgentStory({ view }: { view: AgentDetailView }) {
  if (!view.row.run) return null;
  return (
    <Panel
      title="Ask → result → next"
      actions={
        view.story.ticketHref ? (
          <a href={view.story.ticketHref} onClick={localLink}>
            Open ticket
          </a>
        ) : undefined
      }
    >
      <div className="pb agent-v2-story">
        <div>
          <h3>Original ask</h3>
          {view.story.title ? (
            <BriefReason text={view.story.title} limit={160} label="original ask" />
          ) : (
            <p>No ticket title recorded.</p>
          )}
          {view.story.original.length > 0 ? (
            <details>
              <summary>{view.story.original.length} acceptance checks</summary>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: acceptance text has a bounded scroller. */}
              <ol tabIndex={0} aria-label="Original acceptance checks">
                {view.story.original.map((check) => (
                  <li key={check.line}>{check.text}</li>
                ))}
              </ol>
            </details>
          ) : (
            <p className="muted">Acceptance checks were not recorded for this run.</p>
          )}
        </div>
        <div>
          <h3>Reported result</h3>
          {view.story.report ? (
            <BriefReason text={view.story.report} limit={200} label="reported result" />
          ) : (
            <p className="muted">No result reported yet.</p>
          )}
          {view.story.doneWhen.length > 0 && (
            <details>
              <summary>
                {view.story.doneWhen.filter((item) => item.status === "met").length} of{" "}
                {view.story.original.length || view.story.doneWhen.length} checks reported met
              </summary>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: reported evidence has a bounded scroller. */}
              <ul tabIndex={0} aria-label="Reported acceptance evidence">
                {view.story.doneWhen.map((item) => (
                  <li key={item.line}>
                    <b>{item.status === "met" ? "✓ Reported met" : "○ Reported not met"}:</b>{" "}
                    {item.text}
                    <p className="fg2">{item.evidence}</p>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {view.story.left.length > 0 && (
            <p className="warn-t">Left: {view.story.left.join(" · ")}</p>
          )}
        </div>
      </div>
    </Panel>
  );
}
export function AgentDeliverables({ view }: { view: AgentDetailView }) {
  const links = useRef<HTMLUListElement>(null);
  if (!view.row.run) return null;
  return (
    <Panel title="Deliverables" sub={`${view.deliverables.length} saved links`}>
      <ListScrollCue region={links} label="saved links" count={view.deliverables.length} />
      <ul
        className="agent-v2-deliverables"
        ref={links}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded list scrolls with the keyboard.
        tabIndex={0}
        aria-label="Saved deliverable links"
      >
        {view.deliverables.map((item) => (
          <li key={item.id}>
            <span>
              {item.kind === "screenshot" ? "Image" : item.kind === "file" ? "File" : "PR"}
            </span>
            <a href={item.href} onClick={item.href.startsWith("/agent") ? localLink : undefined}>
              {item.label}
            </a>
          </li>
        ))}
        {view.deliverables.length === 0 && (
          <li>No PR, screenshot or file links are recorded yet.</li>
        )}
      </ul>
    </Panel>
  );
}
export function AgentRelated({ view }: { view: AgentDetailView }) {
  const related = useRef<HTMLUListElement>(null);
  if (view.related.length === 0) return null;
  return (
    <Panel title="Related work" sub="Reviews, subagents and set-aside runs">
      <ListScrollCue region={related} label="related items" count={view.related.length} />
      <ul
        className="agent-v2-related"
        ref={related}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded list scrolls with the keyboard.
        tabIndex={0}
        aria-label="Related reviews and runs"
      >
        <li>
          <b>{callSign(view.row)} · this run</b>
        </li>
        {view.related.map((item) => (
          <li key={item.id}>
            <span aria-hidden="true">↳</span>
            <div>
              {item.href ? (
                <a href={item.href} onClick={localLink}>
                  {item.title}
                </a>
              ) : (
                <b>{item.title}</b>
              )}
              <span>
                {item.status}
                {item.detail ? ` · ${item.detail}` : ""}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
export function AgentContext({ view }: { view: AgentDetailView }) {
  if (!view.context.prompt) return null;
  return (
    <Panel title="Prompt sections" sub="Latest recorded prompt">
      <div className="pb">
        <PromptCostBar cost={view.context.prompt} />
        <p className="s muted">
          {view.context.compactions ?? DASH} compactions this run · sections estimate tokens from
          saved bytes
        </p>
      </div>
    </Panel>
  );
}
