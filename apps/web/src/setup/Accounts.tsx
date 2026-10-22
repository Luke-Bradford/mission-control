import {
  type ConfigView,
  ENGINE_NOT_RUNNING,
  type HealthRow,
  type LimitRow,
  usageCollector,
} from "@mc/core";
import { RESOURCES, useResource } from "../data.ts";
import { GithubRateRow } from "../hud/GithubRateRow.tsx";
import { Meter } from "../hud/Meter.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";

const QUOTA_TITLE =
  "The colours use fixed 80/100 thresholds (amber from 80%, red from 100%); the account's own alert/stop levels are in the columns beside it.";

const AUTO_APPROVE = [
  "GitHub comments",
  "Labels",
  "Board moves and Priority changes",
  "Starting and stopping agents",
  "Switching accounts",
];

/** Setup › Accounts (catalogue 2.7.3), read-only. */
export function Accounts({ config }: { config: ConfigView }) {
  const limits = useResource<LimitRow[]>(RESOURCES.limits).data ?? [];
  const health = useResource<HealthRow[]>(RESOURCES.health).data ?? [];
  const crewAccounts = new Set(
    (config.crew?.sessions ?? []).flatMap((s) => s.seats.map((seat) => seat.accountId)),
  );
  // One login per vendor until phase 5: a crew account is signed in when its usage collector reads.
  const signedIn = (account: string): boolean =>
    crewAccounts.has(account) &&
    health.find((h) => h.collector === usageCollector(account))?.ok === true;
  const pct = (account: string, window: "5h" | "7d"): number | null =>
    limits.find((l) => l.accountId === account && l.window === window)?.used ?? null;
  return (
    <>
      <Panel title="Accounts" sub="one profile per login · Mission Control never reads credentials">
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Provider</th>
                <th>Alert at</th>
                <th>Stop at</th>
                <th>Quota</th>
                <th>Status</th>
                <th>Sign in / Check</th>
              </tr>
            </thead>
            <tbody>
              {config.accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.id}</td>
                  <td>{a.vendor}</td>
                  <td className="num">{a.alertAt}%</td>
                  <td className="num">{a.stopAt}%</td>
                  <td title={QUOTA_TITLE}>
                    <Meter label="5h" pct={pct(a.id, "5h")} />
                    <span aria-hidden="true"> · </span>
                    <Meter label="7d" pct={pct(a.id, "7d")} />
                  </td>
                  <td>{signedIn(a.id) ? <Pill tone="ok">Signed in</Pill> : "—"}</td>
                  <td title={ENGINE_NOT_RUNNING}>—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pb">
          <GithubRateRow />
        </div>
      </Panel>
      <Panel title="Auto-approve" sub="outward writes wait for you until switched on" phase="P2">
        <div className="pb">
          {AUTO_APPROVE.map((label) => (
            <label key={label} className="block s">
              <input type="checkbox" disabled /> {label}
            </label>
          ))}
        </div>
      </Panel>
    </>
  );
}
