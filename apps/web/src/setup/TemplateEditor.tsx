import {
  type ConfigView,
  PROFILE_CHECK_KINDS,
  PROFILE_NAME,
  PROFILE_STEP_PHASES,
  type ProfileStep,
  type ProfileStepPhase,
} from "@mc/core";
import { useEffect, useRef, useState } from "react";

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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Keep the opening version until an explicit refresh; SSE must not silently rebase a draft.
  const [base, setBase] = useState(profiles.version);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const update = (i: number, patch: Partial<DraftStep>) =>
    setSteps(steps.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  const validLimit = (n: number) => Number.isInteger(n) && n >= 1 && n <= 10;
  const validate = () => {
    if (!PROFILE_NAME.test(name))
      return "Name must be lowercase, up to 32 letters, digits or hyphens, starting with a letter.";
    if (profiles.list.some((p) => p.name === name))
      return "Name already exists; choose a unique template name.";
    if (!label.trim()) return "Trigger label is required.";
    if (!base || profiles.error)
      return "Template writes are unavailable. Refresh templates before saving.";
    if (!validLimit(rounds) || !validLimit(tries) || steps.some((s) => !validLimit(s.max ?? 0)))
      return "Rounds, tries and step limits must be whole numbers from 1 to 10.";
    if (budget !== "" && (!Number.isSafeInteger(Number(budget)) || Number(budget) <= 0))
      return "Token budget must be a positive whole number, or empty when unavailable.";
    if (steps.some((s) => !s.name.trim() || s.name.length > 100))
      return "Each step needs a name of up to 100 characters.";
    if (new Set(steps.map((s) => s.name.trim())).size !== steps.length)
      return "Step names must be unique.";
    const phases = steps.map((s) => s.phase);
    if (
      !phases.includes("working") ||
      new Set(phases).size !== phases.length ||
      phases.some(
        (p, i) =>
          i > 0 && PROFILE_STEP_PHASES.indexOf(p) < PROFILE_STEP_PHASES.indexOf(phases[i - 1] ?? p),
      )
    )
      return "Use working, ci and review phases once each, in that order; working is required.";
    if (
      steps.some(
        (s) => !s.checks?.length || s.checks.some((c) => !c.text.trim() || c.text.length > 1000),
      )
    )
      return "Every step needs checks with text of up to 1000 characters.";
    return null;
  };
  return (
    <form
      className="template-editor pb"
      aria-label="New template"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const problem = validate();
        setError(problem);
        if (problem || !base) return;
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
          setError(
            `${e instanceof Error ? e.message : "Could not save template"}. Your draft is kept; correct it or refresh templates and retry.`,
          );
        } finally {
          setBusy(false);
        }
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
      <fieldset disabled={busy}>
        <label>
          Name
          <input
            ref={input}
            value={name}
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Trigger label
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          Rounds
          <input
            type="number"
            min="1"
            max="10"
            value={rounds}
            onChange={(e) => setRounds(Number(e.target.value))}
          />
        </label>
        <label>
          Max tries
          <input
            type="number"
            min="1"
            max="10"
            value={tries}
            onChange={(e) => setTries(Number(e.target.value))}
          />
        </label>
        <label>
          Token budget
          <input type="number" min="1" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
        {steps.map((s, i) => (
          <fieldset key={s.id} className="pcard">
            <legend>Step {i + 1}</legend>
            <label>
              Step name
              <input
                value={s.name}
                maxLength={100}
                onChange={(e) => update(i, { name: e.target.value })}
              />
            </label>
            <label>
              Phase
              <select
                value={s.phase ?? "working"}
                onChange={(e) => update(i, { phase: e.target.value as ProfileStepPhase })}
              >
                {PROFILE_STEP_PHASES.map((phase) => (
                  <option key={phase}>{phase}</option>
                ))}
              </select>
            </label>
            <label>
              Role
              <input
                value={s.role ?? ""}
                maxLength={300}
                onChange={(e) => update(i, { role: e.target.value || undefined })}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={s.gate ?? false}
                onChange={(e) => update(i, { gate: e.target.checked })}
              />
              Gate
            </label>
            <label>
              Step max tries
              <input
                type="number"
                min="1"
                max="10"
                value={s.max}
                onChange={(e) => update(i, { max: Number(e.target.value) })}
              />
            </label>
            <label>
              Retry rule
              <input
                value={s.retry ?? ""}
                maxLength={500}
                onChange={(e) => update(i, { retry: e.target.value || undefined })}
              />
            </label>
            {s.checks?.map((c, j) => (
              <div className="template-check" key={c.id}>
                <label>
                  Check {j + 1} kind
                  <select
                    value={c.kind}
                    onChange={(e) =>
                      update(i, {
                        checks: s.checks?.map((check, n) =>
                          n === j ? { ...check, kind: e.target.value as typeof c.kind } : check,
                        ),
                      })
                    }
                  >
                    {PROFILE_CHECK_KINDS.map((kind) => (
                      <option key={kind}>{kind}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Check {j + 1} text
                  <input
                    value={c.text}
                    maxLength={1000}
                    onChange={(e) =>
                      update(i, {
                        checks: s.checks?.map((check, n) =>
                          n === j ? { ...check, text: e.target.value } : check,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  onClick={() => update(i, { checks: s.checks?.filter((_, n) => n !== j) })}
                >
                  Remove check {j + 1}
                </button>
              </div>
            ))}
            <div className="row wrap">
              <button
                type="button"
                disabled={(s.checks?.length ?? 0) >= 30}
                onClick={() => update(i, { checks: [...(s.checks ?? []), check()] })}
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
        ))}
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
      </fieldset>
      {busy && <p role="status">{refreshing ? "Refreshing templates…" : "Saving template…"}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="row wrap">
        <button type="submit" disabled={busy}>
          {busy && !refreshing ? "Saving…" : "Save template"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setRefreshing(true);
            setBusy(true);
            try {
              const fresh = await onRefresh();
              setBase(fresh.version);
              setError("Templates refreshed. Review your draft and save again.");
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not refresh templates");
            } finally {
              setBusy(false);
              setRefreshing(false);
            }
          }}
        >
          Refresh templates
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
