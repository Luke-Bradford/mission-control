import type { CliAccountStatus, ConfigView, LimitRow } from "@mc/core";
import { Fragment, useState } from "react";
import { apiDelete, apiPost, apiPut } from "../api.ts";
import { copyText } from "../clipboard.ts";
import { useNow, useTz } from "../clock.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { rel, wkdTime } from "../fmt.ts";
import { GithubRateRow } from "../hud/GithubRateRow.tsx";
import { Panel } from "../hud/Panel.tsx";
import { toast } from "../shell/Toast.tsx";

type Account = ConfigView["accounts"][number];
type Models = {
  accountId: string;
  models: { id: string; efforts: readonly string[] }[];
  checkedAt: number;
  error: string | null;
};
type Draft = {
  name: string;
  provider: "claude" | "codex";
  cliProfile: string;
  alertAt: number;
  stopAt: number;
};
const blank = (): Draft => ({
  name: "",
  provider: "codex",
  cliProfile: "",
  alertAt: 80,
  stopAt: 100,
});
const fromAccount = (account: Account): Draft => ({
  name: account.id,
  provider: account.vendor,
  cliProfile: account.cliProfile ?? "",
  alertAt: account.alertAt,
  stopAt: account.stopAt,
});

function signInCommand(account: Account): string {
  if (account.vendor === "claude") return "claude login";
  const profile = account.cliProfile ?? "";
  const quoted = /^[A-Za-z0-9_./:-]+$/.test(profile)
    ? profile
    : `'${profile.replaceAll("'", "'\\''")}'`;
  return `CODEX_HOME=${quoted} codex login`;
}

function projection(row: Extract<LimitRow, { window: "7d" }> | null, tz: string | null) {
  if (!row) return "—";
  if (row.fullAt !== null && tz) return `at this rate: 100% ${wkdTime(row.fullAt, tz)}`;
  return row.projected !== null && row.projected >= 100
    ? "at this rate: reaches 100%"
    : "at this rate: lasts the week";
}

/** A quota bar judged against this account's configured alert and stop thresholds. */
function AccountMeter({
  pct,
  account,
  projected,
}: {
  pct: number | null;
  account: Account;
  projected?: number | null;
}) {
  const value = pct === null ? null : Math.round(pct);
  const level =
    value === null
      ? ""
      : value >= account.stopAt
        ? " full"
        : value >= account.alertAt
          ? " hi"
          : " ok";
  return (
    <span className={`meter account-meter${level}`}>
      <span className="track">
        {projected != null && Number.isFinite(projected) && (
          <b
            className="projection-tick"
            title={`Projected at reset: ${Math.round(projected)}%`}
            style={{ left: `${Math.min(100, Math.max(0, projected))}%` }}
          />
        )}
        {pct !== null && <i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />}
      </span>
      <span className="num xs">{value === null ? "—" : `${value}%`}</span>
    </span>
  );
}

function ModelsCell({ account, now, tz }: { account: Account; now: number; tz: string | null }) {
  const models = useResource<Models>(RESOURCES.accountModels(account.id));
  const [refreshing, setRefreshing] = useState(false);
  const fresh =
    !!models.data && Date.now() - models.data.checkedAt < 24 * 60 * 60 * 1000 && !models.data.error;
  async function refresh() {
    setRefreshing(true);
    try {
      await apiPost(ACTIONS.refreshAccountModels(account.id));
      hub.refetch(RESOURCES.accountModels(account.id).path);
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setRefreshing(false);
    }
  }
  const detail = models.data
    ? `${models.data.models.length} model${models.data.models.length === 1 ? "" : "s"} · ${fresh ? "checked" : "stale"} ${rel(models.data.checkedAt, now, tz ?? "UTC")}`
    : models.loading
      ? "Discovering models…"
      : "Not checked";
  return (
    <>
      <span>{detail}</span>{" "}
      <button type="button" className="sm" disabled={refreshing} onClick={() => void refresh()}>
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
      {models.data?.error && <span className="warn-t s">{models.data.error}</span>}
    </>
  );
}

function SignInPanel({ account }: { account: Account }) {
  const [checking, setChecking] = useState(false);
  const command = signInCommand(account);
  async function checkAgain() {
    setChecking(true);
    try {
      await Promise.all([
        apiPost(ACTIONS.checkAccount(account.id)),
        apiPost(ACTIONS.refreshAccountModels(account.id)),
      ]);
      hub.refetch(RESOURCES.accountStatus.path);
      hub.refetch(RESOURCES.accountModels(account.id).path);
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setChecking(false);
    }
  }
  return (
    <tr className="account-signin-panel">
      <td colSpan={9}>
        <section aria-label={`Sign in again for ${account.id}`}>
          <span>Run this in your own terminal:</span> <code>{command}</code>{" "}
          <button
            type="button"
            className="sm"
            onClick={() =>
              void copyText(
                command,
                "Command copied.",
                "Copy was blocked here; select the command and copy it.",
              )
            }
          >
            Copy
          </button>{" "}
          <button
            type="button"
            className="sm"
            disabled={checking}
            onClick={() => void checkAgain()}
          >
            {checking ? "Checking…" : "Check again"}
          </button>
        </section>
      </td>
    </tr>
  );
}

function AccountEditor({ account, close }: { account: Account | null; close: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => (account ? fromAccount(account) : blank()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = account !== null;
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const body = {
      provider: draft.provider,
      ...(draft.provider === "codex" && draft.cliProfile ? { cliProfile: draft.cliProfile } : {}),
      ...(edit ? { alertAt: draft.alertAt, stopAt: draft.stopAt } : { name: draft.name }),
    };
    try {
      if (edit) await apiPut(ACTIONS.account(account.id), body);
      else await apiPost(ACTIONS.addAccount, body);
      hub.refetch(RESOURCES.config.path);
      hub.refetch(RESOURCES.accountStatus.path);
      if (edit) hub.refetch(RESOURCES.accountModels(account.id).path);
      close();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div
      className="account-editor"
      role="dialog"
      aria-modal="true"
      aria-label={edit ? "Edit account" : "Add account"}
    >
      <form className="seatform" onSubmit={(event) => void save(event)}>
        <h2>{edit ? `Edit ${account.id}` : "Add account"}</h2>
        <label>
          Vendor
          <select
            value={draft.provider}
            disabled={saving || edit}
            onChange={(e) => change("provider", e.target.value as Draft["provider"])}
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <label>
          Name
          <input
            value={draft.name}
            disabled={saving || edit}
            required
            maxLength={40}
            pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,39}"
            onChange={(e) => change("name", e.target.value)}
          />
        </label>
        {draft.provider === "codex" && (
          <label className="account-profile">
            Login profile folder (absolute)
            <input
              value={draft.cliProfile}
              required
              placeholder="/Users/operator/.mc/profiles/codex-work"
              onChange={(e) => change("cliProfile", e.target.value)}
            />
            <span className="muted xs">
              Each Codex account has its own signed-in profile. Credentials are never shown or
              stored by Mission Control.
            </span>
          </label>
        )}
        {edit && (
          <>
            <label>
              Alert at{" "}
              <input
                type="number"
                min="0"
                max="100"
                value={draft.alertAt}
                onChange={(e) => change("alertAt", Number(e.target.value))}
              />
            </label>
            <label>
              Stop at{" "}
              <input
                type="number"
                min="0"
                max="100"
                value={draft.stopAt}
                onChange={(e) => change("stopAt", Number(e.target.value))}
              />
            </label>
          </>
        )}
        {draft.provider === "claude" && (
          <p className="note">
            Claude uses this machine’s one CLI login; profile folders are not supported.
          </p>
        )}
        {error && (
          <p role="alert" className="crit-t s">
            {error}
          </p>
        )}
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save account"}
        </button>{" "}
        <button type="button" disabled={saving} onClick={close}>
          Cancel
        </button>
      </form>
    </div>
  );
}

/** Setup › Accounts: configuration, bindings and usage samples; never credentials or queue state. */
export function Accounts({ config }: { config: ConfigView }) {
  const limits = useResource<LimitRow[]>(RESOURCES.limits).data ?? [];
  const statuses = useResource<CliAccountStatus[]>(RESOURCES.accountStatus);
  const tz = useTz();
  const now = useNow();
  const [editor, setEditor] = useState<Account | null | undefined>(undefined);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const limit = (id: string, window: "5h" | "7d") =>
    limits.find((row) => row.accountId === id && row.window === window) ?? null;
  async function remove(account: Account) {
    if (!window.confirm(`Remove ${account.id}?`)) return;
    setBusy(`remove:${account.id}`);
    try {
      await apiDelete(ACTIONS.account(account.id));
      hub.refetch(RESOURCES.config.path);
      hub.refetch(RESOURCES.accountStatus.path);
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <Panel
        className="wide accounts-panel"
        title="Accounts"
        sub="one profile per login · Mission Control never displays or stores credentials"
        actions={
          <button type="button" onClick={() => setEditor(null)}>
            + Add account
          </button>
        }
      >
        <section className="accounts-table-wrap" aria-label="Account details">
          <table className="accounts-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Vendor</th>
                <th>Login</th>
                <th>Models</th>
                <th>5h</th>
                <th>7d</th>
                <th>Resets</th>
                <th>Alert / stop</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {config.accounts.map((account) => {
                const status = statuses.data?.find((item) => item.accountId === account.id);
                const five = limit(account.id, "5h");
                const seven = limit(account.id, "7d") as Extract<LimitRow, { window: "7d" }> | null;
                const login =
                  account.vendor === "claude"
                    ? "machine login (one per machine)"
                    : (account.cliProfile ?? "profile not configured");
                const forecast = projection(seven, tz);
                return (
                  <Fragment key={account.id}>
                    <tr>
                      <td className="mono">{account.id}</td>
                      <td>{account.vendor === "claude" ? "Claude" : "Codex"}</td>
                      <td className="account-login">
                        <span title={status?.identity ?? undefined}>{login}</span>
                        <span className={status?.status === "logged-in" ? "ok-t" : "muted"}>
                          {status?.status === "logged-in"
                            ? "signed in"
                            : status?.status === "not-logged-in"
                              ? "not signed in"
                              : "not checked"}
                        </span>
                      </td>
                      <td>
                        <ModelsCell account={account} now={now} tz={tz} />
                      </td>
                      <td className="account-quota">
                        <AccountMeter account={account} pct={five?.used ?? null} />
                      </td>
                      <td className="account-quota">
                        <AccountMeter
                          account={account}
                          pct={seven?.used ?? null}
                          projected={seven?.projected ?? null}
                        />
                        <span className="quota-forecast" title={forecast}>
                          {forecast}
                        </span>
                      </td>
                      <td className="mono">
                        {(seven ?? five) && tz ? wkdTime((seven ?? five)?.resetAt ?? 0, tz) : "—"}
                      </td>
                      <td className="mono num">
                        {account.alertAt}% / {account.stopAt}%
                      </td>
                      <td className="account-actions">
                        <button type="button" className="sm" onClick={() => setEditor(account)}>
                          Edit
                        </button>{" "}
                        <button
                          type="button"
                          className="sm"
                          aria-expanded={signingIn === account.id}
                          onClick={() =>
                            setSigningIn((current) => (current === account.id ? null : account.id))
                          }
                        >
                          Sign in again
                        </button>{" "}
                        <button
                          type="button"
                          className="sm"
                          disabled={busy === `remove:${account.id}`}
                          onClick={() => void remove(account)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                    {signingIn === account.id && <SignInPanel account={account} />}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </section>
        {statuses.error && (
          <p role="alert" className="crit-t s">
            Could not load account status: {statuses.error.message}
          </p>
        )}
        {config.accounts.length === 0 && <p className="pb">No accounts configured.</p>}
        <footer className="accounts-github">
          <GithubRateRow />
        </footer>
      </Panel>
      {editor !== undefined && (
        <AccountEditor account={editor} close={() => setEditor(undefined)} />
      )}
    </>
  );
}
