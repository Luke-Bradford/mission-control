import { BACKGROUND_STALL_MS, HUD_STATE_LABEL, HUD_STATES, METRICS, STALL_MS } from "@mc/core";
import { Panel } from "../../hud/Panel.tsx";

/** Anchor for `/setup/sources#glossary` (where the old `/config` and `/settings#glossary` land). */
export const GLOSSARY_ID = "glossary";
/**
 * The prototype's "glossary & data model", cut to what Plan 1 shows and worded for the real
 * system: adopted loops observed from their logs, GitHub and the vendors' usage readings. Terms
 * for later plans are marked with the plan that brings them.
 */
export function Glossary() {
  return (
    <Panel title={<span id={GLOSSARY_ID}>Glossary and data model</span>}>
      <div className="pb">
        <dl className="gloss" aria-label="glossary">
          <dt>entities</dt>
          <dd>
            <code>account</code> · <code>repo</code> (+ its GitHub project and{" "}
            <code>status_map</code>) · <code>loop</code> · <code>run</code> · <code>session</code>{" "}
            (one CLI process) · <code>ticket</code> · <code>escalation</code> · usage{" "}
            <code>sample</code>. Every number on screen is computed from these: the loops' own logs,
            GitHub and the vendors' usage readings. Crew seats come from the <code>crew</code>{" "}
            section of config.yaml, each with a role.
          </dd>
          <dt>agent · loop</dt>
          <dd>
            Each <b>crew seat</b> is one agent that Mission Control runs. Each <b>adopted loop</b>{" "}
            is one agent too: one repo, one account, started by its own launchd job (
            <code>launchd_label</code>) and observed by Mission Control through its{" "}
            <code>state_dir</code>, logs and git worktree. Kinds: <code>ta-loop</code> (a scheduled
            task loop) and <code>studio-loop</code> (a build-driver loop).
          </dd>
          <dt>run</dt>
          <dd>
            One iteration of a loop, known by its ticket and start time. Status: <b>running</b> ·{" "}
            <b>ok</b> · <b>failed</b> · <b>blocked</b> (the loop logged that it is blocked) ·{" "}
            <b>unknown</b> (the log does not say how it ended). <b>duration</b> = start → end, or →
            now while running.
          </dd>
          <dt>ticket</dt>
          <dd>
            Written <code>repo#n</code>: a GitHub issue on the repo's Projects (v2) board. A run's
            ticket is read from its branch name (e.g. <code>feature/3349-…</code>); a run on another
            branch has none.
          </dd>
          <dt>ticket states</dt>
          <dd>
            Each project's Status options map to{" "}
            <code>planned · in progress · review · blocked · done</code> via <code>status_map</code>
            . <b>done</b> on the board = done and updated in the last 7 days. <b>WIP</b> ={" "}
            {METRICS.inProgress.definition}
          </dd>
          <dt>agent states</dt>
          <dd>
            The state pill reads {HUD_STATES.map((s) => HUD_STATE_LABEL[s]).join(" · ")}.{" "}
            <b>Stalled</b> = no output for {STALL_MS / 60_000} minutes (
            {BACKGROUND_STALL_MS / 60_000} while a background task runs). <b>paused</b> = a
            ta-loop's PAUSE file exists.
          </dd>
          <dt>escalation · needs you</dt>
          <dd>
            A GitHub issue that needs your decision. Its title marker —{" "}
            <code>[operator-decision]</code>, <code>[loop-blocked]</code> or{" "}
            <code>[mvp-ready]</code> — means the loop is waiting on you; an SD-32{" "}
            <code>autonomy-question</code> block adds the question, a recommendation and answers.
            Issues with a <code>needs_you_labels</code> label are listed too but never change an
            agent's state. They head the Agents list under needs you; amber is reserved for them.
          </dd>
          <dt>durations</dt>
          <dd>
            <b>in state</b> = since the agent's state last changed · <b>elapsed</b> = since the run
            started · <b>busy</b> = summed wall time of runs, clipped to the window.
          </dd>
          <dt>windows</dt>
          <dd>
            <b>24h</b> = the last 24 hours, rolling. <b>14d</b> = the last 14 days, rolling.{" "}
            <b>5h</b> and <b>7d</b> are the vendors' own limit windows.
          </dd>
          <dt>limits · projection</dt>
          <dd>
            Each account's usage is <b>sampled</b> every <code>poll.usage_minutes</code>; samples
            are the source of truth. <b>7d x→y%</b> = used now → <b>projected at reset</b> = latest
            sample + last-24h pace × hours to reset (no projection until enough samples). A 5h row
            shows used and reset only. <b>stop_at ≈</b> = when the pace reaches <code>stop_at</code>
            ; no new runs start on the account there. <code>alert_at</code> notifications are not
            built yet. <b>stale</b> = the latest sample is older than an hour.
          </dd>
          <dt>≈$ · API-equivalent cost</dt>
          <dd>
            What a run's tokens would cost at API prices, as its transcript reports it.
            Subscriptions are not billed per token: it is never a bill. <code>—</code> = the run
            reported no cost.
          </dd>
          <dt>tokens</dt>
          <dd>Input + output + cache read + cache write.</dd>
          <dt>symbols</dt>
          <dd>
            ≈ = API-equivalent or estimate · <code>—</code> = no data · amber = needs you.
          </dd>
        </dl>
      </div>
    </Panel>
  );
}
