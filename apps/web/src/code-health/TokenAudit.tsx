import type { TokenAuditNamed, TokenAuditRun, TokenAuditView } from "@mc/core";
import { useState } from "react";
import { hub, RESOURCES, useResource } from "../data.ts";
import { cost, kTokens, percent } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { followLink, tracePath } from "../router.ts";
import { message } from "./format.ts";
import "./token-audit.css";

const WINDOWS = [1, 7, 30] as const;
const ROWS = 10;

/** Tokens with their unit: `820 tokens`, `61.0M tokens`, `2.71B tokens`. */
const tokens = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B tokens` : `${kTokens(n)} tokens`;
const count = (n: number, noun: string): string => `${n.toLocaleString("en-GB")} ${noun}`;
const days = (n: number): string => (n === 1 ? "the last day" : `the last ${n} days`);

/** Figures the hub's token audit does not send yet; each says what is missing, in words. */
const NOT_RECORDED: readonly { figure: string; missing: string }[] = [
  {
    figure: "Context per model call by role: 90th percentile, against a budget",
    missing:
      "The hub sends the median peak only, and sets no budget. Runs over a budget cannot be listed.",
  },
  {
    figure: "Commands whose passing output is over 1,000 characters",
    missing: "The hub does not keep whether a command passed, or how long its output was.",
  },
  {
    figure: "Prompt prose sent again unchanged",
    missing: "The hub does not compare one prompt with the one before.",
  },
  {
    figure: "The wait before each cache rewrite",
    missing: "The hub counts rewrites but not the pause that caused each.",
  },
  {
    figure: "Review runs a ticket",
    missing: "Runs are not grouped by ticket in this read.",
  },
  {
    figure: "FLIGHT wakes, wakes with no decision, context at wake, sessions a day",
    missing: "Only the cost of starting sessions is in this read.",
  },
  {
    figure: "Cost per merged PR, by role",
    missing: "The read has cost per run, not per merged PR.",
  },
];

function Bar({ value, max }: { value: number; max: number }) {
  return (
    <span className="ta-track" aria-hidden="true">
      <span style={{ width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%` }} />
    </span>
  );
}

function Named({ rows, label }: { rows: TokenAuditNamed[]; label: string }) {
  const top = rows.slice(0, ROWS);
  const max = top[0]?.reread ?? 0;
  return (
    <table className="ta-table">
      <thead>
        <tr>
          <th scope="col">{label}</th>
          <th scope="col" className="ta-n">
            Re-read
          </th>
          <th scope="col">
            <span className="sr-only">Bar</span>
          </th>
          <th scope="col" className="ta-n">
            Share
          </th>
        </tr>
      </thead>
      <tbody>
        {top.map((r) => (
          <tr key={r.name}>
            <th scope="row" title={r.name}>
              {r.name}
            </th>
            <td className="ta-n">{tokens(r.reread)}</td>
            <td>
              <Bar value={r.reread} max={max} />
            </td>
            <td className="ta-n">{percent(r.share * 100, 1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Runs({ rows }: { rows: TokenAuditRun[] }) {
  return (
    <table className="ta-table">
      <thead>
        <tr>
          <th scope="col">Run</th>
          <th scope="col" className="ta-n">
            Calls
          </th>
          <th scope="col" className="ta-n">
            Peak context
          </th>
          <th scope="col" className="ta-n">
            Re-read
          </th>
          <th scope="col" className="ta-n">
            After report
          </th>
          <th scope="col" className="ta-n">
            Cost
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const to = tracePath(r.agentId, r.runId);
          return (
            <tr key={r.runId}>
              <th scope="row">
                <a href={to} onClick={(e) => followLink(e, to)}>
                  {r.agentId} · {r.runId}
                </a>
              </th>
              <td className="ta-n">{r.calls.toLocaleString("en-GB")}</td>
              <td className="ta-n">{tokens(r.peakContext)}</td>
              <td className="ta-n">{tokens(r.reread)}</td>
              <td className="ta-n">
                {percent(r.readAfterReportShare && r.readAfterReportShare * 100)}
              </td>
              <td className="ta-n">{cost(r.costUsd)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <li className="ta-fig">
      <span className="ta-label">{label}</span>
      <strong>{value}</strong>
      <span className="ta-note">{note}</span>
    </li>
  );
}

function Body({ view }: { view: TokenAuditView }) {
  const win = days(view.days);
  const unlinked = "These rows do not name the run they came from yet, so they cannot link to one.";
  return (
    <>
      <ul className="ta-strip" aria-label="Token figures">
        <Figure label="Runs" value={count(view.runs, "runs")} note={`started in ${win}`} />
        <Figure
          label="Model calls"
          value={count(view.calls, "model calls")}
          note={`${view.runs > 0 ? Math.round(view.calls / view.runs) : 0} a run, ${win}`}
        />
        <Figure
          label="Re-read from cache"
          value={tokens(view.cacheRead)}
          note={`every call re-reads its context, ${win}`}
        />
        <Figure
          label="Cache rewrites"
          value={count(view.rewrites, "cache rewrites")}
          note={`a call wrote over 20k tokens and read under half, ${win}`}
        />
        <Figure
          label="Read after first report"
          value={percent(view.readAfterReportShare && view.readAfterReportShare * 100)}
          note={`of cache reads in runs that reported, ${win}`}
        />
        <Figure
          label="Controller sessions"
          value={
            view.controller
              ? count(view.controller.sessions, "controller sessions")
              : "Not recorded: switched off"
          }
          note={
            view.controller
              ? `${tokens(view.controller.cacheRead)} re-read, ${win}`
              : "Turn on audit.controllerSessions in config to count them"
          }
        />
      </ul>
      <div className="ta-grid">
        <div className="ta-col">
          <Panel title="Biggest sources of re-reading" sub={`Tool or prompt part · ${win}`}>
            <p className="ta-gap">{unlinked}</p>
            <Named rows={view.bySource} label="Tool or part" />
          </Panel>
          <Panel title="Biggest commands" sub={`Shell commands by first word · ${win}`}>
            <p className="ta-gap">{unlinked}</p>
            <Named rows={view.byCommand} label="Command" />
          </Panel>
        </div>
        <div className="ta-col">
          <Panel title="Heaviest runs" sub={`Most re-read, ten at most · ${win}`}>
            <Runs rows={view.topRuns} />
          </Panel>
          <Panel title="By role" sub={`Runs started in ${win}`}>
            <table className="ta-table">
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col" className="ta-n">
                    Runs
                  </th>
                  <th scope="col" className="ta-n">
                    Calls a run
                  </th>
                  <th scope="col" className="ta-n">
                    Median peak context
                  </th>
                  <th scope="col" className="ta-n">
                    Re-read
                  </th>
                  <th scope="col" className="ta-n">
                    Rewrites
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.byRole.map((r) => (
                  <tr key={r.role}>
                    <th scope="row">{r.role}</th>
                    <td className="ta-n">{r.runs.toLocaleString("en-GB")}</td>
                    <td className="ta-n">{r.runs > 0 ? Math.round(r.calls / r.runs) : "—"}</td>
                    <td className="ta-n">{tokens(r.medianPeakContext)}</td>
                    <td className="ta-n">{tokens(r.reread)}</td>
                    <td className="ta-n">{r.rewrites.toLocaleString("en-GB")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
        <div className="ta-col">
          <Panel title="What the hub sent" sub={`Estimated tokens by prompt part · ${win}`}>
            <p className="ta-gap">{unlinked}</p>
            <table className="ta-table">
              <thead>
                <tr>
                  <th scope="col">Prompt part</th>
                  <th scope="col" className="ta-n">
                    Sent
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.hubSections.map((s) => (
                  <tr key={s.section}>
                    <th scope="row">{s.section.replaceAll("_", " ")}</th>
                    <td className="ta-n">{tokens(s.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="FLIGHT" sub={`Cost of starting sessions · ${win}`}>
            {view.flightStart ? (
              <p className="ta-flight">
                <strong>{cost(view.flightStart.usd)}</strong> of FLIGHT's{" "}
                {cost(view.flightStart.totalUsd)} ({percent(view.flightStart.share * 100)}) went on
                starting sessions, over {win}.
              </p>
            ) : (
              <p className="ta-flight">
                There is no FLIGHT seat, so there is no start cost to show.
              </p>
            )}
          </Panel>
          <Panel title="Not recorded yet" sub="The hub does not send these figures">
            <ul className="ta-missing">
              {NOT_RECORDED.map((m) => (
                <li key={m.figure}>
                  <strong>{m.figure}</strong>
                  <span>{m.missing}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}

/** Where the crew's tokens went over a window, and what new waste appeared (`GET /api/audit/tokens`). */
export function TokenAudit() {
  const [window, setWindow] = useState<number>(7);
  const ref = RESOURCES.tokenAudit(window);
  const res = useResource<TokenAuditView>(ref);
  const view = res.data;
  return (
    <div className="ta">
      <div className="ta-bar">
        <p>Where did the crew's tokens go in {days(window)}, and what new waste appeared?</p>
        <fieldset className="ch-window">
          <legend className="sr-only">Token audit window</legend>
          {WINDOWS.map((w) => (
            <button type="button" key={w} aria-pressed={window === w} onClick={() => setWindow(w)}>
              {w === 1 ? "1 day" : `${w} days`}
            </button>
          ))}
        </fieldset>
        <button type="button" onClick={() => hub.refetch(ref.path)} disabled={res.loading}>
          Refresh
        </button>
      </div>
      {res.error && !view && (
        <p role="alert" className="ch-notice">
          The token audit could not be read: {message(res.error)}{" "}
          <button type="button" onClick={() => hub.refetch(ref.path)}>
            Retry
          </button>
        </p>
      )}
      {!view && !res.error && (
        <p role="status" className="ch-notice">
          Reading the token audit for {days(window)}…
        </p>
      )}
      {view && view.runs === 0 && (
        <p role="status" className="ch-notice">
          No runs started in {days(window)}, so there is nothing to audit yet.
        </p>
      )}
      {view && view.runs > 0 && <Body view={view} />}
    </div>
  );
}
