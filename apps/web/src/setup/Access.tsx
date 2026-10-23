import { Panel } from "../hud/Panel.tsx";

const NOTIFY: [string, boolean][] = [
  ["People asking me something in Teams or GitHub", true],
  ["Decisions waiting for me", true],
  ["Stalls and stuck runs", true],
  ["PRs waiting on me", true],
  ["Anything tagged @CAPCOM", true],
  ["The away-mode digest when I come back", true],
  ["Quota above 90%", false],
  ["Every agent message", false],
];

/** Setup › Access and notifications (catalogue 2.7.6), read-only until phase 4. */
export function Access() {
  return (
    <>
      <Panel
        className="wide"
        title="Devices"
        sub="Mission Control runs on the Mac; other devices arrive with Tailscale"
      >
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th>Role</th>
                <th>Connects by</th>
                <th>Notifications</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Mac</td>
                <td>runs Mission Control and the agents</td>
                <td>this machine</td>
                <td>—</td>
                <td>now</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="note pb">Other devices arrive with Tailscale (phase 4).</p>
      </Panel>
      <Panel title="Notify me about" sub="on every signed-in device">
        <div className="pb">
          {NOTIFY.map(([label, on]) => (
            <label key={label} className="block s">
              <input type="checkbox" disabled defaultChecked={on} /> {label}
            </label>
          ))}
          <p className="note">Notifications arrive in phase 4.</p>
        </div>
      </Panel>
      <Panel title="What a notification looks like" sub="samples">
        <div className="pb">
          <div className="notif">
            <b>Mission Control</b>
            <span className="s">
              A teammate asked you in Teams: is this change ready to review?
            </span>
            <span className="xs muted">Read the brief · Open in Teams · Later</span>
          </div>
          <div className="notif">
            <b>Mission Control</b>
            <span className="s">
              Decision for you: ship this change now, or wait for the next release?
            </span>
            <span className="xs muted">Read the brief · Discuss · Later</span>
          </div>
          <div className="notif">
            <b>Mission Control</b>
            <span className="s">
              An agent's full-suite run has printed nothing for 11 min and holds the test lock.
            </span>
            <span className="xs muted">Stop the run · Open</span>
          </div>
        </div>
      </Panel>
    </>
  );
}
