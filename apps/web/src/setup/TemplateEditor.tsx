import {
  type ConfigView,
  PROFILE_CHECK_KINDS,
  PROFILE_NAME,
  PROFILE_STEP_PHASES,
  type ProfileStep,
  type ProfileStepPhase,
} from "@mc/core";
import { useEffect, useId, useRef, useState } from "react";
import {
  ErrorSummary,
  FieldError,
  type FieldIssue,
  fieldProps,
  issueOf,
} from "../components/formSupport.tsx";

type Profiles = NonNullable<ConfigView["profiles"]>;
type Draft = {
  name: string;
  labels: string[];
  steps: ProfileStep[];
  plan_required: boolean;
  reviewer: { role: string; depth: "light" };
  tries: number;
  rounds: number;
  budget: number | null;
};
type DraftCheck = NonNullable<ProfileStep["checks"]>[number] & { id: string };
type DraftStep = Omit<ProfileStep, "checks" | "phase"> & {
  id: string;
  phase: ProfileStepPhase;
  checks: DraftCheck[];
};
const check = (): DraftCheck => ({ id: crypto.randomUUID(), kind: "cmd", text: "" });
const step = (): DraftStep => ({
  id: crypto.randomUUID(),
  name: "implement",
  phase: "working",
  checks: [check()],
  max: 3,
});

/** A linear execution profile, not an orchestration graph. The server validates the write again. */
export function TemplateEditor({
  profiles,
  onCancel,
  onSave,
  onRefresh,
}: {
  profiles: Profiles;
  onCancel: () => void;
  onSave: (profile: Draft, base: string) => Promise<void>;
  onRefresh: () => Promise<Profiles>;
}) {
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [steps, setSteps] = useState<DraftStep[]>(() => [step()]);
  const [rounds, setRounds] = useState(2);
  const [tries, setTries] = useState(3);
  const [budget, setBudget] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [failure, setFailure] = useState<{ title: string; text: string } | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Keep the opening version until an explicit refresh; SSE must not silently rebase a draft.
  const [base, setBase] = useState(profiles.version);
  const input = useRef<HTMLInputElement>(null);
  const prefix = useId();
  const ids = {
    name: `${prefix}-name`,
    label: `${prefix}-label`,
    rounds: `${prefix}-rounds`,
    tries: `${prefix}-tries`,
    budget: `${prefix}-budget`,
    refresh: `${prefix}-refresh`,
  };
  /** Field ids of one step (and of its checks), stable while the step moves. */
  const stepIds = (s: DraftStep) => ({
    name: `${prefix}-${s.id}-name`,
    phase: `${prefix}-${s.id}-phase`,
    role: `${prefix}-${s.id}-role`,
    max: `${prefix}-${s.id}-max`,
    retry: `${prefix}-${s.id}-retry`,
    addCheck: `${prefix}-${s.id}-add-check`,
    checkKind: (c: DraftCheck) => `${prefix}-${c.id}-kind`,
    checkText: (c: DraftCheck) => `${prefix}-${c.id}-text`,
  });
  useEffect(() => input.current?.focus(), []);
  const update = (i: number, patch: Partial<DraftStep>) =>
    setSteps(steps.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  const validLimit = (n: number) => Number.isInteger(n) && n >= 1 && n <= 10;
  /** What the server's schema would refuse, found before sending; the server stays the judge. */
  const validate = (): FieldIssue[] => {
    const found: FieldIssue[] = [];
    if (!PROFILE_NAME.test(name))
      found.push({
        id: ids.name,
        message:
          "Name must be lowercase, up to 32 letters, digits or hyphens, starting with a letter.",
      });
    else if (profiles.list.some((p) => p.name === name))
      found.push({ id: ids.name, message: "Name already exists; choose a unique template name." });
    if (!label.trim()) found.push({ id: ids.label, message: "Trigger label is required." });
    if (!base || profiles.error)
      found.push({
        id: ids.refresh,
        message: "Template writes are unavailable. Refresh templates before saving.",
      });
    if (!validLimit(rounds))
      found.push({ id: ids.rounds, message: "Rounds must be a whole number from 1 to 10." });
    if (!validLimit(tries))
      found.push({ id: ids.tries, message: "Max tries must be a whole number from 1 to 10." });
    if (budget !== "" && (!Number.isSafeInteger(Number(budget)) || Number(budget) <= 0))
      found.push({
        id: ids.budget,
        message: "Token budget must be a positive whole number, or empty when unavailable.",
      });
    const phases = steps.map((s) => s.phase);
    const badPhase = phases.findIndex(
      (p, i) =>
        phases.indexOf(p) !== i ||
        (i > 0 && PROFILE_STEP_PHASES.indexOf(p) < PROFILE_STEP_PHASES.indexOf(phases[i - 1] ?? p)),
    );
    steps.forEach((s, i) => {
      const f = stepIds(s);
      const at = `Step ${i + 1}`;
      if (!s.name.trim() || s.name.length > 100)
        found.push({ id: f.name, message: `${at}: a name of up to 100 characters is required.` });
      else if (steps.some((x, n) => n < i && x.name.trim() === s.name.trim()))
        found.push({ id: f.name, message: `${at}: step names must be unique.` });
      const noWorking = badPhase === -1 && i === 0 && !phases.includes("working");
      if (badPhase === i || noWorking)
        found.push({
          id: f.phase,
          message: `${at}: use working, ci and review phases once each, in that order; working is required.`,
        });
      if (!validLimit(s.max ?? 0))
        found.push({ id: f.max, message: `${at}: max tries must be a whole number from 1 to 10.` });
      if (!s.checks.length)
        found.push({ id: f.addCheck, message: `${at}: add at least one check.` });
      s.checks.forEach((c, j) => {
        if (!c.text.trim() || c.text.length > 1000)
          found.push({
            id: f.checkText(c),
            message: `${at}, check ${j + 1}: text of up to 1000 characters is required.`,
          });
      });
    });
    return found;
  };
  const issues = attempted ? validate() : [];
  const lessThan = (id: string) => issueOf(issues, id);
  const title = issues.length > 0 ? "Fix before saving" : (failure?.title ?? "Not saved");
  const submit = async () => {
    if (busy) return;
    setAttempted(true);
    setFailure(null);
    if (validate().length > 0) {
      setFocusKey((key) => key + 1);
      return;
    }
    if (!base) return;
    setBusy(true);
    try {
      await onSave(
        {
          name,
          labels: [label.trim()],
          steps: steps.map(({ id: _id, ...s }) => ({
            ...s,
            name: s.name.trim(),
            checks: s.checks.map(({ id: _id, ...c }) => ({ ...c, text: c.text.trim() })),
          })),
          plan_required: false,
          reviewer: { role: "RETRO", depth: "light" },
          tries,
          rounds,
          budget: budget === "" ? null : Number(budget),
        },
        base,
      );
    } catch (e) {
      setFailure({
        title: "Not saved",
        text: `${e instanceof Error ? e.message : "Could not save template"}. Your draft is kept; correct it or refresh templates and retry.`,
      });
      setFocusKey((key) => key + 1);
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    setBusy(true);
    try {
      const fresh = await onRefresh();
      setBase(fresh.version);
      setFailure({
        title: "Templates refreshed",
        text: "Templates refreshed. Review your draft and save again.",
      });
    } catch (e) {
      setFailure({
        title: "Not refreshed",
        text: e instanceof Error ? e.message : "Could not refresh templates",
      });
    } finally {
      setBusy(false);
      setRefreshing(false);
      setFocusKey((key) => key + 1);
    }
  };
  return (
    <form
      className="template-editor fform fform-800"
      aria-label="New template"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <p className="s">
        Create a checked template using working → ci → review. Each phase may appear once. Parallel
        orchestration is available only as a built-in description. Step checks, gates, retry rules
        and budgets describe the workflow; execution keeps the existing phase checks and retry
        policy.
      </p>
      <fieldset className="fcontent" disabled={busy}>
        <fieldset className="fgroup">
          <legend>Template</legend>
          <div className="fpair">
            <div className="ffield">
              <label htmlFor={ids.name}>Name</label>
              <input
                {...fieldProps(ids.name, lessThan(ids.name))}
                ref={input}
                value={name}
                maxLength={32}
                onChange={(e) => setName(e.target.value)}
              />
              <FieldError id={ids.name} error={lessThan(ids.name)} />
            </div>
            <div className="ffield">
              <label htmlFor={ids.label}>Trigger label</label>
              <input
                {...fieldProps(ids.label, lessThan(ids.label))}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
              <FieldError id={ids.label} error={lessThan(ids.label)} />
            </div>
          </div>
        </fieldset>
        <fieldset className="fgroup">
          <legend>Limits</legend>
          <div className="fpair">
            <div className="ffield">
              <label htmlFor={ids.rounds}>Rounds</label>
              <input
                {...fieldProps(ids.rounds, lessThan(ids.rounds))}
                type="number"
                min="1"
                max="10"
                value={rounds}
                onChange={(e) => setRounds(Number(e.target.value))}
              />
              <FieldError id={ids.rounds} error={lessThan(ids.rounds)} />
            </div>
            <div className="ffield">
              <label htmlFor={ids.tries}>Max tries</label>
              <input
                {...fieldProps(ids.tries, lessThan(ids.tries))}
                type="number"
                min="1"
                max="10"
                value={tries}
                onChange={(e) => setTries(Number(e.target.value))}
              />
              <FieldError id={ids.tries} error={lessThan(ids.tries)} />
            </div>
          </div>
          <div className="fpair">
            <div className="ffield">
              <label htmlFor={ids.budget}>Token budget</label>
              <input
                {...fieldProps(ids.budget, lessThan(ids.budget))}
                type="number"
                min="1"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
              <FieldError id={ids.budget} error={lessThan(ids.budget)} />
            </div>
          </div>
        </fieldset>
        {steps.map((s, i) => {
          const f = stepIds(s);
          return (
            <fieldset key={s.id} className="fgroup">
              <legend>Step {i + 1}</legend>
              <div className="fpair">
                <div className="ffield">
                  <label htmlFor={f.name}>Step name</label>
                  <input
                    {...fieldProps(f.name, lessThan(f.name))}
                    value={s.name}
                    maxLength={100}
                    onChange={(e) => update(i, { name: e.target.value })}
                  />
                  <FieldError id={f.name} error={lessThan(f.name)} />
                </div>
                <div className="ffield">
                  <label htmlFor={f.phase}>Phase</label>
                  <select
                    {...fieldProps(f.phase, lessThan(f.phase))}
                    value={s.phase ?? "working"}
                    onChange={(e) => update(i, { phase: e.target.value as ProfileStepPhase })}
                  >
                    {PROFILE_STEP_PHASES.map((phase) => (
                      <option key={phase}>{phase}</option>
                    ))}
                  </select>
                  <FieldError id={f.phase} error={lessThan(f.phase)} />
                </div>
              </div>
              <div className="fpair">
                <div className="ffield">
                  <label htmlFor={f.role}>Role</label>
                  <input
                    id={f.role}
                    value={s.role ?? ""}
                    maxLength={300}
                    onChange={(e) => update(i, { role: e.target.value || undefined })}
                  />
                </div>
                <div className="ffield">
                  <label htmlFor={f.retry}>Retry rule</label>
                  <input
                    id={f.retry}
                    value={s.retry ?? ""}
                    maxLength={500}
                    onChange={(e) => update(i, { retry: e.target.value || undefined })}
                  />
                </div>
              </div>
              <div className="fpair">
                <div className="ffield">
                  <label htmlFor={f.max}>Step max tries</label>
                  <input
                    {...fieldProps(f.max, lessThan(f.max))}
                    type="number"
                    min="1"
                    max="10"
                    value={s.max}
                    onChange={(e) => update(i, { max: Number(e.target.value) })}
                  />
                  <FieldError id={f.max} error={lessThan(f.max)} />
                </div>
                <div className="ffield">
                  <label className="ffield-check">
                    <input
                      type="checkbox"
                      checked={s.gate ?? false}
                      onChange={(e) => update(i, { gate: e.target.checked })}
                    />
                    Gate
                  </label>
                </div>
              </div>
              {s.checks.map((c, j) => (
                <div className="template-check" key={c.id}>
                  <div className="ffield">
                    <label htmlFor={f.checkKind(c)}>Check {j + 1} kind</label>
                    <select
                      id={f.checkKind(c)}
                      value={c.kind}
                      onChange={(e) =>
                        update(i, {
                          checks: s.checks.map((check, n) =>
                            n === j ? { ...check, kind: e.target.value as typeof c.kind } : check,
                          ),
                        })
                      }
                    >
                      {PROFILE_CHECK_KINDS.map((kind) => (
                        <option key={kind}>{kind}</option>
                      ))}
                    </select>
                  </div>
                  <div className="ffield">
                    <label htmlFor={f.checkText(c)}>Check {j + 1} text</label>
                    <input
                      {...fieldProps(f.checkText(c), lessThan(f.checkText(c)))}
                      value={c.text}
                      maxLength={1000}
                      onChange={(e) =>
                        update(i, {
                          checks: s.checks.map((check, n) =>
                            n === j ? { ...check, text: e.target.value } : check,
                          ),
                        })
                      }
                    />
                    <FieldError id={f.checkText(c)} error={lessThan(f.checkText(c))} />
                  </div>
                  <button
                    type="button"
                    onClick={() => update(i, { checks: s.checks.filter((_, n) => n !== j) })}
                  >
                    Remove check {j + 1}
                  </button>
                </div>
              ))}
              <FieldError id={f.addCheck} error={lessThan(f.addCheck)} />
              <div className="fact">
                <button
                  id={f.addCheck}
                  type="button"
                  aria-invalid={lessThan(f.addCheck) === undefined ? undefined : true}
                  disabled={s.checks.length >= 30}
                  onClick={() => update(i, { checks: [...s.checks, check()] })}
                >
                  Add check
                </button>
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() =>
                    setSteps(
                      steps.map((x, n) => (n === i - 1 ? s : n === i ? (steps[i - 1] ?? x) : x)),
                    )
                  }
                >
                  Move up
                </button>
                <button
                  type="button"
                  disabled={i === steps.length - 1}
                  onClick={() =>
                    setSteps(
                      steps.map((x, n) => (n === i + 1 ? s : n === i ? (steps[i + 1] ?? x) : x)),
                    )
                  }
                >
                  Move down
                </button>
                <button
                  type="button"
                  disabled={steps.length === 1}
                  onClick={() => setSteps(steps.filter((_, n) => n !== i))}
                >
                  Remove step
                </button>
              </div>
            </fieldset>
          );
        })}
        <div className="fact">
          <button
            type="button"
            disabled={steps.length >= 3}
            onClick={() =>
              setSteps([
                ...steps,
                {
                  ...step(),
                  name: steps.length === 1 ? "verify" : "review",
                  phase: steps.length === 1 ? "ci" : "review",
                },
              ])
            }
          >
            Add step
          </button>
        </div>
      </fieldset>
      {busy && (
        <p role="status" className="fstatus s">
          {refreshing ? "Refreshing templates…" : "Saving template…"}
        </p>
      )}
      <ErrorSummary
        title={title}
        issues={issues}
        message={failure?.text ?? null}
        focusKey={focusKey}
      />
      <div className="fact">
        <button className="primary" type="submit" disabled={busy}>
          {busy && !refreshing ? "Saving…" : "Save template"}
        </button>
        <button id={ids.refresh} type="button" disabled={busy} onClick={() => void refresh()}>
          Refresh templates
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
