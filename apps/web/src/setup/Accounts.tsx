import type { CliAccountStatus, ConfigView, LimitRow } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { useTz } from "../clock.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { wkdTime } from "../fmt.ts";
import { GithubRateRow } from "../hud/GithubRateRow.tsx";
import { Meter } from "../hud/Meter.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { toast } from "../shell/Toast.tsx";

const QUOTA_TITLE =
  "The colours use fixed 80/100 thresholds (amber from 80%, red from 100%); the account's own alert/stop levels are in the columns beside it.";

const AUTO_APPROVE = [
  "GitHub comments",
  "Labels",
  "Board moves and Priority changes",
  "Starting and stopping agents",
  "Switching accounts",
];

function newestReading(local?: CliAccountStatus, listed?: CliAccountStatus) {
  return local && (!listed || local.checkedAt >= listed.checkedAt) ? local : listed;
}

/** Setup › Accounts (catalogue 2.7.3): machine CLI readings and config only. */
export function Accounts({ config }: { config: ConfigView }) {
  const limits = useResource<LimitRow[]>(RESOURCES.limits).data ?? [];
  const statuses = useResource<CliAccountStatus[]>(RESOURCES.accountStatus);
  const tz = useTz();
  const [checks, setChecks] = useState<
    Record<
      string,
      {
        reading?: CliAccountStatus;
        busy?: boolean;
        error?: string;
        unknown?: boolean;
        clearedListError?: Error | null;
      }
    >
  >({});
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [provider, setProvider] = useState("claude");
  const [name, setName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  async function check(id: string) {
    const previous = newestReading(
      checks[id]?.reading,
      statuses.data?.find((s) => s.accountId === id),
    );
    setChecks((all) => ({ ...all, [id]: { ...all[id], busy: true } }));
    try {
      const next = await apiPost<CliAccountStatus>(ACTIONS.checkAccount(id));
      if (next.status !== "unknown") {
        toast(
          `${id}: ${next.status === "logged-in" ? "signed in" : "not signed in"} (checked with the provider's own status command).`,
        );
      }
      setChecks((all) => ({
        ...all,
        [id]: {
          reading: next.status === "unknown" && previous ? previous : next,
          unknown: next.status === "unknown",
          clearedListError: next.status !== "unknown" ? statuses.error : undefined,
          error: next.status === "unknown" ? (next.detail ?? "CLI status unavailable") : undefined,
        },
      }));
    } catch (error) {
      setChecks((all) => ({
        ...all,
        [id]: { reading: previous, error: (error as Error).message },
      }));
    }
  }
  async function add() {
    setSaving(true);
    setAddError(null);
    try {
      await apiPost(ACTIONS.addAccount, { provider, name });
      hub.refetch(RESOURCES.config.path);
      hub.refetch(RESOURCES.accountStatus.path);
      setAdding(false);
      setName("");
    } catch (error) {
      setAddError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const limit = (account: string, window: "5h" | "7d") =>
    limits.find((entry) => entry.accountId === account && entry.window === window) ?? null;
  return (
    <>
      <Panel
        title="Accounts"
        sub="one profile per login · Mission Control never reads credentials"
        actions={
          <button type="button" onClick={() => setAdding(true)}>
            Add account
          </button>
        }
      >
        <div className="pb">
          <p className="note">
            Sign in with the CLI on this machine. Mission Control reads this machine's CLI login,
            identity and plan.
          </p>
          {adding && (
            <form
              className="seatform"
              aria-label="Add account"
              onSubmit={(event) => {
                event.preventDefault();
                void add();
              }}
            >
              <p className="note">
                Add account: choose Claude or Codex and a short name. Adds configuration only; one
                account per provider is supported.
              </p>
              <label>
                Provider{" "}
                <select
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                  disabled={saving}
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>{" "}
              <label>
                Short config name{" "}
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={40}
                  pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,39}"
                  disabled={saving}
                />
              </label>{" "}
              <button type="submit" disabled={saving}>
                {saving ? "Adding…" : "Add account"}
              </button>{" "}
              <button type="button" disabled={saving} onClick={() => setAdding(false)}>
                Cancel
              </button>
              {addError && (
                <p role="alert" className="crit-t s">
                  {addError}
                </p>
              )}
            </form>
          )}
          {statuses.loading && <p role="status">Loading account status…</p>}
          {statuses.error && (
            <p role="alert" className="crit-t s">
              Could not load account status: {statuses.error.message}
            </p>
          )}
          {config.accounts.length === 0 && <p>No accounts configured.</p>}
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll the wide table. */}
        <section className="tw accounts-table-wrap" aria-label="Account details" tabIndex={0}>
          <table className="accounts-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Vendor</th>
                <th>Login</th>
                <th>Plan</th>
                <th>5h</th>
                <th>7d</th>
                <th>Resets</th>
                <th>Alert / stop</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {config.accounts.map((a) => {
                const checkState = checks[a.id];
                const reading = newestReading(
                  checkState?.reading,
                  statuses.data?.find((s) => s.accountId === a.id),
                );
                const local = !!checkState && reading === checkState.reading;
                const checkError = local ? checkState?.error : undefined;
                const stale =
                  !!checkError ||
                  (!!statuses.error && (!local || statuses.error !== checkState?.clearedListError));
                const status = local && checkState?.unknown ? "unknown" : reading?.status;
                const fiveHour = limit(a.id, "5h");
                const sevenDay = limit(a.id, "7d");
                const reset = sevenDay ?? fiveHour;
                return (
                  <tr key={a.id}>
                    <td className="mono">{a.id}</td>
                    <td>{a.vendor}</td>
                    <td className="account-login">
                      <span>{reading?.identity ?? "—"}</span>
                      <Pill tone={status === "logged-in" ? "ok" : "neutral"}>
                        {status === "logged-in"
                          ? "Signed in"
                          : status === "not-logged-in"
                            ? "Not signed in"
                            : "Unknown"}
                      </Pill>
                    </td>
                    <td>{reading?.plan ?? "—"}</td>
                    <td className="account-quota" title={QUOTA_TITLE}>
                      <Meter label="5h" pct={fiveHour?.used ?? null} />
                    </td>
                    <td className="account-quota" title={QUOTA_TITLE}>
                      <Meter
                        label="7d"
                        pct={sevenDay?.used ?? null}
                        projected={sevenDay?.projected ?? null}
                      />
                      {sevenDay?.projected !== null && sevenDay?.projected !== undefined && (
                        <span className="quota-forecast">{`${Math.round(sevenDay.projected)}% forecast`}</span>
                      )}
                    </td>
                    <td className="mono">{reset && tz ? wkdTime(reset.resetAt, tz) : "—"}</td>
                    <td className="mono num">{`${a.alertAt}% / ${a.stopAt}%`}</td>
                    <td className="account-actions">
                      <button
                        type="button"
                        disabled={checkState?.busy}
                        onClick={() => void check(a.id)}
                      >
                        {checkState?.busy ? "Checking…" : "Check"}
                      </button>
                      <div className="muted xs">
                        {reading
                          ? `${stale ? "Stale · last checked" : "Checked"} ${new Date(reading.checkedAt).toISOString()}`
                          : "Not checked"}
                      </div>
                      {(checkError || reading?.detail) && (
                        <p role="status" className="warn-t s">
                          {checkError ?? reading?.detail}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
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
