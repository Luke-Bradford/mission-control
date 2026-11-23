import { type AccountModelsView, type ConfigView, errorText, type SeatInput } from "@mc/core";
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError } from "../api.ts";
import {
  ErrorSummary,
  FieldError,
  type FieldIssue,
  fieldProps,
  issueOf,
  isUncertain,
  UNCERTAIN_TEXT,
  useSubmitGuard,
} from "../components/formSupport.tsx";
import { hub, RESOURCES, useResource } from "../data.ts";
import { CALL_SIGN, CALL_SIGN_HINT, SCRATCH_LABEL } from "./Sessions.tsx";

const AREA_HINT_TEXT =
  "Comma-separated folders or globs, such as apps/web/**. Empty means the whole checkout.";

type Session = NonNullable<ConfigView["crew"]>["sessions"][number];

export function roleLabel(config: ConfigView, role: string): string {
  const found = config.crew?.roles?.find((item) => item.name === role);
  return found?.here ? `${found.here} (${role})` : role;
}
export const inputOf = (seat: Session["seats"][number]): SeatInput => ({
  id: seat.id,
  ...(seat.displayCallSign === null || seat.displayCallSign === undefined
    ? {}
    : { displayCallSign: seat.displayCallSign }),
  ...(seat.focus === null || seat.focus === undefined ? {} : { focus: seat.focus }),
  role: seat.role,
  accountId: seat.accountId,
  model: seat.model,
  ...(seat.mode === "scratch" ? { mode: "scratch" as const } : {}),
  area: seat.area,
});
/** What the server's schema would refuse, found before sending; the server stays the judge. */
function seatIssues(
  form: SeatInput,
  adding: boolean,
  taken: string[],
  ids: Record<"sign" | "role" | "account" | "model", string>,
  models: "ready" | "loading" | "error" | "none",
): FieldIssue[] {
  const found: FieldIssue[] = [];
  if (adding) {
    if (!CALL_SIGN.test(form.id))
      found.push({
        id: ids.sign,
        message: `Call sign: ${CALL_SIGN_HINT}, starting with a letter.`,
      });
    else if (taken.includes(form.id))
      found.push({ id: ids.sign, message: "Call sign is already used by a seat in this repo." });
  }
  if (!form.role) found.push({ id: ids.role, message: "Role is required." });
  if (!form.accountId)
    found.push({ id: ids.account, message: "Account: none is configured; add one in Accounts." });
  if (!form.model.trim())
    found.push({
      // A disabled Model cannot take focus: with no choices the link goes to Account instead.
      id: models === "ready" ? ids.model : ids.account,
      message:
        models === "loading"
          ? "Model is required. The model list is still loading."
          : models === "error"
            ? "Model is required. The model list could not be read: retry it below."
            : models === "none"
              ? "Model is required. This account has no discovered models: pick another account."
              : "Model is required.",
    });
  return found;
}

/**
 * The add and edit seat form. The draft is local: a refused or lost save leaves what was typed and
 * says why here, not only in a toast. `onSave` resolves when the write is done and rejects with
 * the failure; while it is out the fields are held and a second submit is ignored.
 */
export function SeatEditor({
  seat,
  missing = false,
  taken,
  config,
  defaultAccount,
  onCancel,
  onSave,
}: {
  seat?: SeatInput;
  /** The seat being edited has left config.yaml since the form opened. */
  missing?: boolean;
  taken: string[];
  config: ConfigView;
  defaultAccount: string;
  onCancel: () => void;
  onSave: (seat: SeatInput) => Promise<void>;
}) {
  const firstRole = config.crew?.roles?.[0]?.name ?? "";
  const [form, setForm] = useState<SeatInput>(
    seat ?? { id: "", role: firstRole, accountId: defaultAccount, model: "", area: [] },
  );
  const [areaText, setAreaText] = useState((seat?.area ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ text: string; uncertain: boolean } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  const guard = useSubmitGuard();
  const alive = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    alive.current = true;
    // Opens at its first control, scrolled into view.
    const first = formRef.current?.querySelector<HTMLElement>(
      "input:not(:disabled), select:not(:disabled)",
    );
    first?.focus();
    first?.scrollIntoView?.({ block: "nearest" });
    return () => {
      alive.current = false;
    };
  }, []);
  const base = useId();
  const ids = {
    sign: `${base}-sign`,
    role: `${base}-role`,
    account: `${base}-account`,
    model: `${base}-model`,
    effort: `${base}-effort`,
    area: `${base}-area`,
    scratch: `${base}-scratch`,
  };
  /** Comma-separated globs; none means the whole checkout. */
  const areaOf = (): string[] =>
    areaText
      .split(",")
      .map((glob) => glob.trim())
      .filter(Boolean);
  const catalogRead = useResource<AccountModelsView[]>(RESOURCES.allAccountModels);
  const catalog = catalogRead.data;
  const options = catalog?.find((account) => account.accountId === form.accountId)?.models ?? [];
  // An old seat may have a model that has since left a provider catalog.  Keep it visible while
  // editing that seat, but never make it a choice for a new one.
  const models = useMemo(
    () =>
      seat && form.model && !options.some((option) => option.model === form.model)
        ? [{ model: form.model, efforts: [] }, ...options]
        : options,
    [seat, form.model, options],
  );
  const efforts = options.find((option) => option.model === form.model)?.efforts ?? [];
  useEffect(() => {
    if (!seat && form.model === "" && options[0]) setForm({ ...form, model: options[0].model });
  }, [seat, form, options]);
  const modelsState: "ready" | "loading" | "error" | "none" =
    models.length > 0
      ? "ready"
      : catalogRead.loading && !catalog
        ? "loading"
        : catalogRead.error
          ? "error"
          : "none";
  const noModels =
    modelsState === "loading"
      ? "Loading models…"
      : modelsState === "error"
        ? "Could not read models"
        : "No discovered models";
  const issues = attempted ? seatIssues(form, !seat, taken, ids, modelsState) : [];
  const signError = issueOf(issues, ids.sign);
  const roleError = issueOf(issues, ids.role);
  const accountError = issueOf(issues, ids.account);
  const modelError = issueOf(issues, ids.model);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!guard.take()) return;
    setAttempted(true);
    if (seatIssues(form, !seat, taken, ids, modelsState).length > 0) {
      guard.release();
      setFailure(null);
      setFocusKey((key) => key + 1);
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      const { mode: _mode, ...rest } = form;
      await onSave({
        ...rest,
        area: areaOf(),
        ...(form.mode === "scratch" ? { mode: "scratch" as const } : {}),
      });
    } catch (cause) {
      if (alive.current) {
        setFailure({
          text: errorText(cause),
          uncertain: isUncertain(cause instanceof ApiError ? cause.status : undefined),
        });
        setFocusKey((key) => key + 1);
      }
    } finally {
      guard.release();
      if (alive.current) setSaving(false);
    }
  };
  const title =
    issues.length > 0 ? "Fix before saving" : failure?.uncertain ? "Result unknown" : "Not saved";
  return (
    <form
      ref={formRef}
      className="fform fform-640"
      noValidate
      aria-label={seat ? `Edit ${seat.id}` : "Add seat"}
      onSubmit={(event) => void submit(event)}
    >
      <fieldset className="fgroup">
        <legend>Seat</legend>
        <div className="ffield">
          <label htmlFor={ids.sign}>Call sign</label>
          <input
            {...fieldProps(ids.sign, signError, `${ids.sign}-hint`)}
            value={form.id}
            disabled={!!seat || saving}
            onChange={(e) => setForm({ ...form, id: e.target.value })}
          />
          <span id={`${ids.sign}-hint`} className="fhint muted xs">
            {seat
              ? "A call sign cannot change once the seat exists."
              : `${CALL_SIGN_HINT}, starting with a letter.`}
          </span>
          <FieldError id={ids.sign} error={signError} />
        </div>
        <div className="ffield">
          <label htmlFor={ids.role}>Role</label>
          <select
            {...fieldProps(ids.role, roleError)}
            title={roleLabel(config, form.role)}
            value={form.role}
            disabled={saving}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          >
            {config.crew?.roles?.map((role) => (
              <option key={role.name} value={role.name}>
                {roleLabel(config, role.name)}
              </option>
            ))}
          </select>
          <FieldError id={ids.role} error={roleError} />
        </div>
      </fieldset>
      <fieldset className="fgroup">
        <legend>Account and model</legend>
        <div className="fpair">
          <div className="ffield">
            <label htmlFor={ids.account}>Account</label>
            <select
              {...fieldProps(ids.account, accountError)}
              title={
                form.accountId === defaultAccount
                  ? `${form.accountId} (repo default)`
                  : form.accountId
              }
              value={form.accountId}
              disabled={saving}
              onChange={(e) =>
                setForm({ ...form, accountId: e.target.value, model: "", effort: undefined })
              }
            >
              {config.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.id === defaultAccount ? `${account.id} (repo default)` : account.id}
                </option>
              ))}
            </select>
            <FieldError id={ids.account} error={accountError} />
          </div>
          <div className="ffield">
            <label htmlFor={ids.model}>Model</label>
            <select
              {...fieldProps(ids.model, modelError)}
              title={form.model || noModels}
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value, effort: undefined })}
              disabled={saving || models.length === 0}
            >
              <option value="">{noModels}</option>
              {models.map((model) => (
                <option key={model.model} value={model.model}>
                  {model.model}
                </option>
              ))}
            </select>
            <FieldError id={ids.model} error={modelError} />
            {modelsState === "error" && catalogRead.error && (
              <p className="crit-t xs">
                Could not read the model list: {catalogRead.error.message}{" "}
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => hub.refetch(RESOURCES.allAccountModels.path)}
                >
                  Retry
                </button>
              </p>
            )}
          </div>
        </div>
        <div className="fpair">
          <div className="ffield">
            <label htmlFor={ids.effort}>Effort</label>
            <select
              id={ids.effort}
              value={form.effort ?? ""}
              disabled={saving}
              onChange={(e) => setForm({ ...form, effort: e.target.value || undefined })}
            >
              <option value="">CLI default</option>
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </div>
          <div className="ffield">
            <label className="ffield-check">
              <input type="checkbox" checked disabled /> Enabled
            </label>
          </div>
        </div>
      </fieldset>
      <fieldset className="fgroup">
        <legend>Work area</legend>
        <div className="ffield">
          <label htmlFor={ids.area}>Area</label>
          <span id={`${ids.area}-hint`} className="fhint xs">
            {AREA_HINT_TEXT}
          </span>
          <input
            id={ids.area}
            aria-describedby={`${ids.area}-hint`}
            value={areaText}
            disabled={saving}
            onChange={(e) => setAreaText(e.target.value)}
          />
        </div>
        <div className="ffield ffield-check">
          <input
            id={ids.scratch}
            type="checkbox"
            checked={form.mode === "scratch"}
            disabled={saving}
            onChange={(e) => setForm({ ...form, mode: e.target.checked ? "scratch" : undefined })}
          />
          <label htmlFor={ids.scratch}>{SCRATCH_LABEL}</label>
        </div>
      </fieldset>
      {missing && seat && (
        <p role="status" className="feffect s">
          {seat.id} is no longer in config.yaml. Add it back with these values, or cancel.
        </p>
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
          Saving seat…
        </p>
      )}
      <div className="fact">
        <button className="primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : missing ? "Add it back" : "Save seat"}
        </button>
        <button type="button" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
