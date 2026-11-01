import {
  type ConfigView,
  FREE_SUITE_HINT,
  GUARD_NOTE,
  GUARD_RULES,
  type GuardHitsView,
  type GuardRule,
  LOCK_WAIT_MS,
  ROLES,
} from "@mc/core";
import { LockLines, useTestLock } from "../components/LockLines.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";

const RULES = Object.keys(GUARD_RULES) as GuardRule[];

/** Setup › Roles, guard and test lock (catalogue 2.7.4). */
export function Roles() {
  const hits = useResource<GuardHitsView>(RESOURCES.guardHits).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const lock = useTestLock();
  return (
    <>
      <Panel
        title="Roles"
        sub="roles/*.md · call signs from the Apollo control room; rename any agent"
        className="wide"
      >
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th scope="col">Call sign</th>
                <th scope="col">Apollo position</th>
                <th scope="col">Here</th>
                <th scope="col">Mode</th>
              </tr>
            </thead>
            <tbody>
              {ROLES.map((r) => (
                <tr key={r.callSign}>
                  <td>{r.callSign}</td>
                  <td>{r.position}</td>
                  <td className="wrap" title={r.here}>
                    {r.here}
                  </td>
                  <td>{r.mode ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Guard" sub="hard stops enforced in code · hits this week" className="wide">
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Hits</th>
              </tr>
            </thead>
            <tbody>
              {RULES.map((r) => (
                <tr key={r}>
                  <td className="wrap" title={GUARD_RULES[r]}>
                    {GUARD_RULES[r]}
                  </td>
                  <td className="num">{hits ? hits.counts[r] : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pb">
          <p className="s muted">{GUARD_NOTE}</p>
        </div>
      </Panel>
      <Panel
        title="Test lock"
        sub="which commands count as a full suite, per repo profile"
        className="wide"
      >
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th scope="col">Repo profile</th>
                <th scope="col">Full suite (takes the lock)</th>
                <th scope="col">Runs freely</th>
              </tr>
            </thead>
            <tbody>
              {(config?.repos ?? []).map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td className="wrap" title={r.fullSuite.join(", ")}>
                    {r.fullSuite.length > 0 ? r.fullSuite.join(", ") : "—"}
                  </td>
                  <td className="wrap" title={FREE_SUITE_HINT}>
                    {FREE_SUITE_HINT}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pb">
          <p className="note">
            One full suite at a time across the machine; others wait in line, oldest first. A
            full-suite command an agent types is held in the same line and runs when it reaches the
            front; after about {LOCK_WAIT_MS / 60_000} minutes it is told to retry later or run a
            single file. Max at once: <b>1</b>. Single-file runs go straight through.
          </p>
          <LockLines lock={lock} />
        </div>
      </Panel>
    </>
  );
}
