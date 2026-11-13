import type { CodeHealthRecommendation } from "@mc/core";
import { Fragment, useId } from "react";
import { Panel } from "../hud/Panel.tsx";
import {
  decider,
  nowToTarget,
  PATH_STEPS,
  pathIndex,
  reviewDate,
  stateWord,
} from "./auditFormat.ts";
import type { Action } from "./dialogs.tsx";
import { label } from "./format.ts";
import { ScrollRegion } from "./ScrollRegion.tsx";

export type Who = "all" | "operator" | "flight";
export const WHO_OF = (row: CodeHealthRecommendation): Who => decider(row).tier ?? "all";

const ACTIONS: readonly Action[] = ["accept", "dismiss", "snooze"];
const cap = (text: string) => text[0]?.toUpperCase() + text.slice(1);

/** The ranked proposals: one question per row, the evidence one click away in its detail. */
export function DoNext({
  rows,
  filter,
  onFilter,
  open,
  onOpen,
  blocked,
  empty,
  onAction,
  onEvidence,
  onHistory,
}: {
  rows: CodeHealthRecommendation[];
  filter: Who;
  onFilter: (who: Who) => void;
  open: string | null;
  onOpen: (id: string | null) => void;
  blocked: boolean;
  /** What to say when there are no rows (loading, failed, or truly none). */
  empty: string;
  onAction: (row: CodeHealthRecommendation, kind: Action) => void;
  onEvidence: (row: CodeHealthRecommendation) => void;
  onHistory: () => void;
}) {
  const detail = useId();
  const yours = rows.filter((r) => WHO_OF(r) === "operator").length;
  const flights = rows.filter((r) => WHO_OF(r) === "flight").length;
  const shown = filter === "all" ? rows : rows.filter((r) => WHO_OF(r) === filter);
  return (
    <Panel
      className="ao-next"
      title="Do next"
      sub={
        <>
          <b>{rows.length}</b> ranked · strongest cause first, then largest measured baseline
        </>
      }
      actions={
        <>
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and a border the panel head has no room for */}
          <span className="seg" role="group" aria-label="Who decides">
            {(
              [
                ["all", `All ${rows.length}`],
                ["operator", `Yours ${yours}`],
                ["flight", `FLIGHT's ${flights}`],
              ] as const
            ).map(([value, text]) => (
              <button
                key={value}
                type="button"
                className={filter === value ? "on" : ""}
                aria-pressed={filter === value}
                onClick={() => onFilter(value)}
              >
                {text}
              </button>
            ))}
          </span>
          <button type="button" className="ao-link" onClick={onHistory}>
            Recommendation history
          </button>
        </>
      }
    >
      <ScrollRegion className="ao-scroll" label="Ranked recommendations">
        {rows.length === 0 ? (
          <p className="ao-empty">{empty}</p>
        ) : shown.length === 0 ? (
          <p className="ao-empty">
            None of the {rows.length} ranked rows is decided by{" "}
            {filter === "operator" ? "you" : "FLIGHT"}. Choose All to see them.
          </p>
        ) : (
          <table className="ao-table">
            <colgroup>
              <col className="c-n" />
              <col className="c-from" />
              <col />
              <col className="c-meas" />
              <col className="c-dec" />
              <col className="c-act" />
            </colgroup>
            <thead>
              <tr>
                <th>#</th>
                <th>From</th>
                <th>What to change, and why</th>
                <th>Measure · now → target</th>
                <th>Decides · state</th>
                <th className="num">Decide</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const rank = rows.indexOf(row) + 1;
                const isOpen = open === row.id;
                const who = decider(row);
                const m = nowToTarget(row);
                const title = row.title ?? row.proposal;
                return (
                  <Fragment key={row.id}>
                    <tr className={isOpen ? "ao-row open" : "ao-row"} data-who={WHO_OF(row)}>
                      <td className="n">{rank}</td>
                      <td>
                        <span className="src">{label(row.rule)}</span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="rt"
                          aria-expanded={isOpen}
                          aria-controls={`${detail}-${row.id}`}
                          onClick={() => onOpen(isOpen ? null : row.id)}
                        >
                          <i aria-hidden="true">{isOpen ? "▾" : "▸"}</i>
                          <span className="clamp" title={title}>
                            {title}
                          </span>
                        </button>
                        <div className="why clamp" title={row.observation}>
                          {row.observation}
                        </div>
                      </td>
                      <td>
                        <div className="meas">
                          <span className="l" title={m.metric}>
                            {m.metric}
                          </span>
                          <span className="v">
                            <i className={m.known ? "ds a" : "ds n"} aria-hidden="true" />
                            <span>{m.text}</span>
                          </span>
                        </div>
                      </td>
                      <td className="dec">
                        <b className={who.tier === "operator" ? "you" : undefined}>{who.who}</b>
                        <span>
                          {stateWord(row.state)} · {reviewDate(row.state)}
                        </span>
                      </td>
                      <td>
                        <div className="acts">
                          {ACTIONS.map((kind) => (
                            <button
                              type="button"
                              key={kind}
                              className={kind === "accept" ? "btn pri" : "btn"}
                              disabled={blocked}
                              aria-label={`${cap(kind)}: ${title}`}
                              onClick={() => onAction(row, kind)}
                            >
                              {cap(kind)}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="ao-more" id={`${detail}-${row.id}`}>
                        <td colSpan={6}>
                          <div className="mg">
                            <div>
                              <h3>Why believe it</h3>
                              <p>{row.observation}</p>
                              <p className="m">{row.rankingReason}</p>
                              <button
                                type="button"
                                className="ao-link"
                                onClick={() => onEvidence(row)}
                              >
                                Inspect evidence for rank {rank}
                              </button>
                            </div>
                            <div>
                              <h3>What could be wrong</h3>
                              <p>{row.uncertainty}</p>
                            </div>
                            <div>
                              <h3>Risks</h3>
                              <p>
                                No risk note is recorded for this proposal. Accepting records an
                                owner and a baseline; it applies no code or rules.
                              </p>
                              {row.measure && <p className="m">{row.measure.coverage}</p>}
                            </div>
                            <div>
                              <h3>State path</h3>
                              <ol className="steps">
                                {PATH_STEPS.map((step, i) => (
                                  <li
                                    key={step}
                                    className={i === pathIndex(row.state) ? "cur" : undefined}
                                    aria-current={i === pathIndex(row.state) ? "step" : undefined}
                                  >
                                    {step}
                                  </li>
                                ))}
                              </ol>
                              <p>
                                {stateWord(row.state)} · {reviewDate(row.state)}
                                {who.owner ? ` · decided by ${who.owner}` : ""}
                              </p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </ScrollRegion>
    </Panel>
  );
}
