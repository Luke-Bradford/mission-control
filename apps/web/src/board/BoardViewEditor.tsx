import { useEffect, useId, useRef, useState } from "react";
import {
  ErrorSummary,
  FieldError,
  type FieldIssue,
  fieldProps,
  issueOf,
} from "../components/formSupport.tsx";
import {
  type BoardView,
  type Choice,
  VIEW_FIELDS,
  VIEW_NOT_SAVED_TEXT,
  type ViewField,
} from "./boardView.ts";

const GROUPS: Record<ViewField, { legend: string; none: string; noun: string }> = {
  labels: { legend: "Labels", none: "No labels", noun: "label" },
  priority: { legend: "Priority", none: "No priority", noun: "priority" },
  assignee: { legend: "Assignee", none: "Unassigned", noun: "assignee" },
  milestone: { legend: "Milestone", none: "No milestone", noun: "milestone" },
};

const chosen = (c: Choice): string[] => (c.kind === "some" ? c.values : []);

/**
 * The inline Board view form (F13). It edits a draft; Save hands the draft to `onSave`, Cancel
 * throws it away. `options` are the values on the cached cards; a saved value no card has any more
 * stays listed and selected, marked so.
 */
export function BoardViewEditor({
  applied,
  options,
  loading,
  onSave,
  onCancel,
}: {
  applied: BoardView;
  options: Record<ViewField, string[]>;
  /** The cards have not all arrived: the lists are not known yet, so nothing is called absent. */
  loading: boolean;
  /** Returns whether the browser kept the view; false leaves the form open with a notice. */
  onSave: (view: BoardView) => boolean;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<BoardView>(applied);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [focusKey, setFocusKey] = useState(0);
  const [refused, setRefused] = useState(false);
  const ids = useId();
  const idOf = (field: ViewField, part: string) => `${ids}-${field}-${part}`;
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>("input")?.focus();
  }, []);

  const set = (field: ViewField, choice: Choice) => {
    setDraft((d) => ({ ...d, [field]: choice }));
    setRefused(false);
  };
  const toggle = (field: ViewField, value: string, on: boolean) => {
    const rest = chosen(draft[field]).filter((v) => v !== value);
    set(field, { kind: "some", values: on ? [...rest, value] : rest });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const found = VIEW_FIELDS.flatMap((field): FieldIssue[] => {
      const c = draft[field];
      return c.kind === "some" && c.values.length === 0
        ? [
            {
              id: idOf(field, "some"),
              message: `Choose at least one ${GROUPS[field].noun}, or pick Any.`,
            },
          ]
        : [];
    });
    setIssues(found);
    if (found.length > 0) {
      setFocusKey((k) => k + 1);
      return;
    }
    const kept = onSave(draft);
    if (!kept) setRefused(true);
  };

  return (
    <form
      ref={formRef}
      className="fform fform-800 boardview"
      noValidate
      id="boardViewForm"
      aria-label="Board view"
      onSubmit={submit}
    >
      <p className="fhint muted s">Saved in this browser</p>
      {VIEW_FIELDS.map((field) => {
        const g = GROUPS[field];
        const choice = draft[field];
        const picked = chosen(choice);
        const listed = options[field];
        const absent = picked.filter(
          (v) =>
            !listed.some((o) =>
              field === "assignee" ? o.toLowerCase() === v.toLowerCase() : o === v,
            ),
        );
        const error = issueOf(issues, idOf(field, "some"));
        const radio = (kind: Choice["kind"], label: string, id: string) => (
          <label className="ffield-check" htmlFor={id}>
            <input
              {...(kind === "some" ? fieldProps(id, error) : { id })}
              type="radio"
              name={idOf(field, "kind")}
              checked={choice.kind === kind}
              onChange={() => set(field, kind === "some" ? { kind, values: picked } : { kind })}
            />
            {label}
          </label>
        );
        return (
          <fieldset key={field} className="fgroup">
            <legend>{g.legend}</legend>
            <div className="bv-kinds">
              {radio("any", "Any", idOf(field, "any"))}
              {radio("none", g.none, idOf(field, "none"))}
              {radio("some", "Only these", idOf(field, "some"))}
              {field === "labels" && (
                <div className="ffield bv-match">
                  <label htmlFor={idOf(field, "match")}>Match</label>
                  <select
                    id={idOf(field, "match")}
                    value={draft.labelMatch}
                    onChange={(e) => {
                      setDraft({ ...draft, labelMatch: e.target.value === "all" ? "all" : "any" });
                      setRefused(false);
                    }}
                  >
                    <option value="any">Any of these</option>
                    <option value="all">All of these</option>
                  </select>
                </div>
              )}
            </div>
            <FieldError id={idOf(field, "some")} error={error} />
            {loading ? (
              <p className="fhint muted s">Loading the cards…</p>
            ) : listed.length + absent.length === 0 ? (
              <p className="fhint muted s">No cards carry a {g.noun} yet.</p>
            ) : (
              <ul className="bv-options" aria-label={`${g.legend} values`}>
                {[...listed, ...absent].map((value) => {
                  const id = `${idOf(field, "v")}-${value}`;
                  const missing = absent.includes(value);
                  return (
                    <li key={value}>
                      <label className="ffield-check" htmlFor={id}>
                        <input
                          id={id}
                          type="checkbox"
                          checked={picked.some((v) =>
                            field === "assignee"
                              ? v.toLowerCase() === value.toLowerCase()
                              : v === value,
                          )}
                          onChange={(e) => toggle(field, value, e.target.checked)}
                        />
                        <span className="bv-value">{value}</span>
                        {missing && <span className="muted xs">not on any current card</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
        );
      })}
      <ErrorSummary title="Fix before saving" issues={issues} message={null} focusKey={focusKey} />
      {refused && (
        <p role="status" className="feffect s">
          {VIEW_NOT_SAVED_TEXT}
        </p>
      )}
      <div className="fact">
        <button className="primary" type="submit">
          Save Board view
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
