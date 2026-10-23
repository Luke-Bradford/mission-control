import { type ConfigProfile, type ConfigView, RETRY_NOTE, SMALL_SIZES } from "@mc/core";
import { useState } from "react";
import { Panel } from "../hud/Panel.tsx";
import { inSession, useSession } from "../shell/session.ts";

/** What picks a profile: its labels, then what it catches when a ticket carries no template label. */
export function profileTrigger(p: ConfigProfile): string {
  const base =
    p.labels.length > 0
      ? `label ${p.labels.join(" or ")}`
      : "no label: FLIGHT or the planner picks it";
  if (p.name === "small-change") {
    return `${base}, or Size ${SMALL_SIZES.join(" or ")} with no template label`;
  }
  if (p.name === "feature") return `${base}, or any other ticket with no template label`;
  return base;
}

/** Who does a step, by its loop phase. */
export function stepRole(p: ConfigProfile, step: ConfigProfile["steps"][number]): string {
  switch (step.phase) {
    case "working":
      return "The writer seat";
    case "ci":
      return "Mission Control runs the CI checks";
    case "review":
      return `${p.reviewer.role}, fresh eyes · ${p.reviewer.depth} review`;
    case null:
      return "No loop phase: shown for the record";
  }
}

function stepExtra(p: ConfigProfile, step: ConfigProfile["steps"][number]): string | null {
  if (step.phase === "ci") return `Up to ${p.tries} tries.`;
  if (step.phase === "review") return `Up to ${p.rounds} rounds.`;
  return null;
}

/** The Templates panel and the picked profile's track (catalogue 2.7.2), read-only. */
function Templates({ profiles }: { profiles: NonNullable<ConfigView["profiles"]> }) {
  const [picked, setPicked] = useState<string | null>(null);
  const { list, error, source } = profiles;
  const p = list.find((x) => x.name === picked) ?? list[0];
  return (
    <>
      <Panel title="Templates" sub={source === "built-in" ? "built-in profiles" : source}>
        {error !== null ? (
          <p className="pb s">{`Could not read the template profiles: ${error}`}</p>
        ) : list.length === 0 ? (
          <p className="pb s muted">No template profiles.</p>
        ) : (
          <ul className="pb tlist">
            {list.map((x) => (
              <li key={x.name}>
                <button
                  type="button"
                  aria-pressed={x.name === p?.name}
                  onClick={() => setPicked(x.name)}
                >
                  {`${x.name} · ${profileTrigger(x)} · ${x.steps.length} steps`}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {p !== undefined && (
        <Panel title={p.name} sub={`runs for: ${profileTrigger(p)}`}>
          <ol className="ptrack" aria-label="Steps">
            {p.steps.map((s, i) => (
              <li key={s.name}>
                <b>{i + 1}</b> {s.name}
              </li>
            ))}
          </ol>
          <div className="pb">
            <p className="s">
              {`Up to ${p.rounds} rounds${p.planRequired ? " · Plan required before a developer starts" : ""}`}
            </p>
            <p className="xs muted">{RETRY_NOTE}</p>
          </div>
          <div className="pcards">
            {p.steps.map((s, i) => (
              <div key={s.name} className="pcard">
                <b>{`${i + 1} · ${s.name}`}</b>
                <span className="s">{stepRole(p, s)}</span>
                {stepExtra(p, s) !== null && <span className="s">{stepExtra(p, s)}</span>}
              </div>
            ))}
          </div>
        </Panel>
      )}
      <p className="pb note">{TEMPLATES_NOTE}</p>
    </>
  );
}

const NO_PROFILES = "This server reads no template profiles.";
const NO_OBSERVED_LOOPS = "No observed loops.";

const TEMPLATES_NOTE =
  "Mission Control decides every move from its own checks; an agent saying it is done can only hold work back, never push it forward. cmd = Mission Control runs it · rule = read from the diff or the board · review = a fresh reviewer · gate = you or FLIGHT · agent = the agent's own evidence.";

/** Setup › Loops (catalogue 2.7.2), read-only: the observed loops, and the template profiles. */
export function Loops({ config }: { config: ConfigView }) {
  const [session] = useSession();
  const loops = config.loops.filter((l) => inSession(session, l.repoId));
  return (
    <>
      <Panel title="Observed loops" sub="read from config.yaml">
        {loops.length === 0 ? (
          <p className="pb muted s">{NO_OBSERVED_LOOPS}</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Loop</th>
                  <th>Kind</th>
                  <th>Repo</th>
                  <th>Account</th>
                  <th>launchd label</th>
                  <th>Worktree</th>
                </tr>
              </thead>
              <tbody>
                {loops.map((l) => (
                  <tr key={l.id}>
                    <td>{l.id}</td>
                    <td>{l.kind}</td>
                    <td>{l.repoId}</td>
                    <td>{l.accountId}</td>
                    <td className="mono">{l.launchdLabel}</td>
                    <td className="mono">{l.worktree}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {config.profiles === undefined ? (
        <Panel title="Templates" sub="loops/*.yaml">
          <div className="pb">
            <p className="s">{NO_PROFILES}</p>
            <p className="xs muted">{RETRY_NOTE}</p>
            <p className="note">{TEMPLATES_NOTE}</p>
          </div>
        </Panel>
      ) : (
        <Templates profiles={config.profiles} />
      )}
    </>
  );
}
