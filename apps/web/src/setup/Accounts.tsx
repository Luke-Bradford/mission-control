import { type CliAccountStatus, type ConfigView, errorText, type LimitRow } from "@mc/core";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { ApiError, apiDelete, apiPost, apiPut } from "../api.ts";
import { copyText } from "../clipboard.ts";
import { useNow, useTz } from "../clock.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { percent, plural, rel, wkdTime } from "../fmt.ts";
import { GithubRateRow } from "../hud/GithubRateRow.tsx";
import { Panel } from "../hud/Panel.tsx";
import { popOverlay, pushOverlay, trapTab, useReturnFocus } from "../shell/overlays.ts";
import { toast } from "../shell/Toast.tsx";
import {
  ErrorSummary,
  FieldError,
  type FieldIssue,
  fieldProps,
  issueOf,
  isUncertain,
  UNCERTAIN_TEXT,
  useSubmitGuard,
} from "./formSupport.tsx";

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
  alertAt: string;
  stopAt: string;
};
const blank = (): Draft => ({
  name: "",
  provider: "codex",
  cliProfile: "",
  alertAt: "80",
  stopAt: "100",
});
const fromAccount = (account: Account): Draft => ({
  name: account.id,
  provider: account.vendor,
  cliProfile: account.cliProfile ?? "",
  alertAt: String(account.alertAt),
  stopAt: String(account.stopAt),
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
            title={`Projected at reset: ${percent(projected)}`}
            style={{ left: `${Math.min(100, Math.max(0, projected))}%` }}
          />
        )}
        {pct !== null && <i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />}
      </span>
      <span className="num xs">{percent(value)}</span>
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
    ? `${plural(models.data.models.length, "model")} · ${fresh ? "checked" : "stale"} ${rel(models.data.checkedAt, now, tz ?? "UTC")}`
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

const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const PROFILE_MAX = 4096;
const OVERLAY_ID = "account-editor";
const FIELD = (key: string) => `account-${key}`;

/** What the server's schema would refuse, found before sending; the server stays the judge. */
function accountIssues(
  draft: Draft,
  edit: boolean,
  ids: Record<string, string>,
  hadProfile: boolean,
): FieldIssue[] {
  const found: FieldIssue[] = [];
  if (!edit && !ACCOUNT_NAME.test(draft.name))
    found.push({
      id: ids.name,
      message: "Name must be 1–40 letters, digits, . _ or -, starting with a letter or digit.",
    });
  if (draft.provider === "codex") {
    if (draft.cliProfile === "" && hadProfile)
      found.push({
        id: ids.profile,
        message: "Login profile folder cannot be emptied once it is set.",
      });
    else if (draft.cliProfile.length > PROFILE_MAX)
      found.push({
        id: ids.profile,
        message: `Login profile folder can be at most ${PROFILE_MAX} characters.`,
      });
  }
  if (edit) {
    const whole = (text: string) => /^\d{1,3}$/.test(text) && Number(text) <= 100;
    if (!whole(draft.alertAt))
      found.push({ id: ids.alert, message: "Alert at must be a whole number from 0 to 100." });
    if (!whole(draft.stopAt))
      found.push({ id: ids.stop, message: "Stop at must be a whole number from 0 to 100." });
    if (whole(draft.alertAt) && whole(draft.stopAt) && Number(draft.alertAt) > Number(draft.stopAt))
      found.push({ id: ids.alert, message: "Alert at must not exceed Stop at." });
  }
  return found;
}

/**
 * The add and edit account form, a modal on the shared overlay helpers. The draft is local: a
 * refused or lost save, or a refreshed config, leaves what was typed. While a save is out the
 * fields, Cancel and Escape are held, so nothing closes under it and nothing is sent twice.
 */
function AccountEditor({ account, close }: { account: Account | null; close: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => (account ? fromAccount(account) : blank()));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ text: string; uncertain: boolean } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  const guard = useSubmitGuard();
  const alive = useRef(true);
  const dialog = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const base = useId();
  const ids = {
    provider: `${base}-${FIELD("provider")}`,
    name: `${base}-${FIELD("name")}`,
    profile: `${base}-${FIELD("profile")}`,
    alert: `${base}-${FIELD("alert")}`,
    stop: `${base}-${FIELD("stop")}`,
  };
  const edit = account !== null;
  const hadProfile = !!account?.cliProfile;
  const issues = attempted ? accountIssues(draft, edit, ids, hadProfile) : [];
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  useReturnFocus(true);
  useEffect(() => {
    alive.current = true;
    first.current?.focus();
    // Esc (the shell's key handler) closes the topmost overlay; a save in flight keeps it open.
    const onEscape = () => {
      if (guard.pending()) pushOverlay(OVERLAY_ID, onEscape);
      else closeRef.current();
    };
    pushOverlay(OVERLAY_ID, onEscape);
    return () => {
      alive.current = false;
      popOverlay(OVERLAY_ID);
    };
  }, [guard]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!guard.take()) return;
    const found = accountIssues(draft, edit, ids, hadProfile);
    setAttempted(true);
    if (found.length > 0) {
      guard.release();
      setFailure(null);
      setFocusKey((key) => key + 1);
      return;
    }
    setSaving(true);
    setFailure(null);
    // Every control is disabled while the write is out: keep focus inside the modal.
    dialog.current?.focus();
    const body = {
      provider: draft.provider,
      ...(draft.provider === "codex" && draft.cliProfile ? { cliProfile: draft.cliProfile } : {}),
      ...(edit
        ? { alertAt: Number(draft.alertAt), stopAt: Number(draft.stopAt) }
        : { name: draft.name }),
    };
    try {
      if (edit) await apiPut(ACTIONS.account(account.id), body);
      else await apiPost(ACTIONS.addAccount, body);
      hub.refetch(RESOURCES.config.path);
      hub.refetch(RESOURCES.accountStatus.path);
      if (edit) hub.refetch(RESOURCES.accountModels(account.id).path);
      if (alive.current) close();
    } catch (cause) {
      const uncertain = isUncertain(cause instanceof ApiError ? cause.status : undefined);
      if (uncertain) {
        // The server may have saved before the answer was lost: read what is saved before a retry.
        hub.refetch(RESOURCES.config.path);
        hub.refetch(RESOURCES.accountStatus.path);
      }
      if (alive.current) {
        setFailure({ text: errorText(cause), uncertain });
        setFocusKey((key) => key + 1);
      } else toast(errorText(cause));
    } finally {
      guard.release();
      if (alive.current) setSaving(false);
    }
  }

  const nameError = issueOf(issues, ids.name);
  const profileError = issueOf(issues, ids.profile);
  const alertError = issueOf(issues, ids.alert);
  const stopError = issueOf(issues, ids.stop);
  const title =
    issues.length > 0 ? "Fix before saving" : failure?.uncertain ? "Result unknown" : "Not saved";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop takes focus from a click, so Tab stays trapped
    <div
      className="account-editor"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          if (!guard.pending()) close();
          return;
        }
        // While a write is out every control is disabled, so there is nothing to Tab to: hold focus here.
        if (e.key === "Tab" && guard.pending()) {
          e.preventDefault();
          return;
        }
        trapTab(e);
      }}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        className="account-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={edit ? "Edit account" : "Add account"}
      >
        <form className="fform" noValidate onSubmit={(event) => void save(event)}>
          <h2>{edit ? `Edit ${account.id}` : "Add account"}</h2>
          <fieldset className="fgroup">
            <legend>Identity</legend>
            <div className="fpair">
              <div className="ffield">
                <label htmlFor={ids.provider}>Vendor</label>
                <select
                  id={ids.provider}
                  value={draft.provider}
                  disabled={saving || edit}
                  onChange={(e) => change("provider", e.target.value as Draft["provider"])}
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </div>
              <div className="ffield">
                <label htmlFor={ids.name}>Name</label>
                <input
                  {...fieldProps(ids.name, nameError, `${ids.name}-hint`)}
                  ref={edit ? undefined : first}
                  value={draft.name}
                  disabled={saving || edit}
                  maxLength={40}
                  onChange={(e) => change("name", e.target.value)}
                />
                <FieldError id={ids.name} error={nameError} />
              </div>
            </div>
            <p id={`${ids.name}-hint`} className="fhint muted xs">
              {edit
                ? "Vendor and name cannot change once the account exists: seats and loops refer to it."
                : "1–40 letters, digits, . _ or -, starting with a letter or digit."}
            </p>
          </fieldset>
          <fieldset className="fgroup">
            <legend>Sign-in</legend>
            {draft.provider === "codex" ? (
              <div className="ffield">
                <label htmlFor={ids.profile}>Login profile folder (absolute, optional)</label>
                <input
                  {...fieldProps(ids.profile, profileError, `${ids.profile}-hint`)}
                  value={draft.cliProfile}
                  disabled={saving}
                  placeholder="/Users/operator/.mc/profiles/codex-work"
                  onChange={(e) => change("cliProfile", e.target.value)}
                />
                <span id={`${ids.profile}-hint`} className="fhint muted xs">
                  Each Codex account has its own signed-in profile. Empty uses this machine's Codex
                  login. Credentials are never shown or stored by Mission Control.
                </span>
                <FieldError id={ids.profile} error={profileError} />
              </div>
            ) : (
              <p className="note s">
                Claude uses this machine’s one CLI login; profile folders are not supported.
              </p>
            )}
          </fieldset>
          {edit && (
            <fieldset className="fgroup">
              <legend>Usage thresholds</legend>
              <div className="fpair">
                <div className="ffield">
                  <label htmlFor={ids.alert}>Alert at</label>
                  <input
                    {...fieldProps(ids.alert, alertError, `${ids.alert}-hint`)}
                    ref={first}
                    type="number"
                    min="0"
                    max="100"
                    value={draft.alertAt}
                    disabled={saving}
                    onChange={(e) => change("alertAt", e.target.value)}
                  />
                  <FieldError id={ids.alert} error={alertError} />
                </div>
                <div className="ffield">
                  <label htmlFor={ids.stop}>Stop at</label>
                  <input
                    {...fieldProps(ids.stop, stopError, `${ids.alert}-hint`)}
                    type="number"
                    min="0"
                    max="100"
                    value={draft.stopAt}
                    disabled={saving}
                    onChange={(e) => change("stopAt", e.target.value)}
                  />
                  <FieldError id={ids.stop} error={stopError} />
                </div>
              </div>
              <p id={`${ids.alert}-hint`} className="fhint muted xs">
                Percent of a limit used. Usage bars turn to alert at the first value and to full at
                the second. Whole numbers from 0 to 100; alert must not exceed stop.
              </p>
            </fieldset>
          )}
          <ErrorSummary
            title={title}
            issues={issues}
            message={failure?.text ?? null}
            focusKey={focusKey}
          >
            {failure?.uncertain && issues.length === 0 && <p className="s">{UNCERTAIN_TEXT}</p>}
          </ErrorSummary>
          {saving && (
            <p role="status" className="fstatus s">
              Saving account…
            </p>
          )}
          <div className="fact">
            <button type="submit" className="primary" disabled={saving}>
              {saving ? "Saving…" : "Save account"}
            </button>
            <button type="button" disabled={saving} onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      </div>
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
                        {percent(account.alertAt)} / {percent(account.stopAt)}
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
        <AccountEditor
          key={editor?.id ?? "new"}
          account={editor}
          close={() => setEditor(undefined)}
        />
      )}
    </>
  );
}
