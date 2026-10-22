import { type ConfigView, ENGINE_NOT_RUNNING, RETRY_NOTE } from "@mc/core";
import { Panel } from "../hud/Panel.tsx";
import { inSession, useSession } from "../shell/session.ts";

/** Setup › Loops (catalogue 2.7.2), read-only: the observed loops, and the templates' placeholder. */
export function Loops({ config }: { config: ConfigView }) {
  const [session] = useSession();
  const loops = config.loops.filter((l) => inSession(session, l.repoId));
  return (
    <>
      <Panel title="Observed loops" sub="read from config.yaml">
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
      </Panel>
      <Panel title="Templates" sub="loops/*.yaml">
        <div className="pb">
          <p className="s">{ENGINE_NOT_RUNNING}</p>
          <p className="xs muted">{RETRY_NOTE}</p>
          <p className="note">
            Mission Control decides every move from its own checks; an agent saying it is done can
            only hold work back, never push it forward. cmd = Mission Control runs it · rule = read
            from the diff or the board · review = a fresh reviewer · gate = you or FLIGHT · agent =
            the agent's own evidence.
          </p>
        </div>
      </Panel>
    </>
  );
}
