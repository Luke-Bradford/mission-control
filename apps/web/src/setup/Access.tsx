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
    </>
  );
}
