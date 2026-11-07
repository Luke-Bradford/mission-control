import type { AwaySettings } from "@mc/core";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError, apiPost } from "../api.ts";
import { useTz } from "../clock.ts";
import {
  ErrorSummary,
  FieldError,
  type FieldIssue,
  fieldProps,
  isUncertain,
  UNCERTAIN_TEXT,
  useSubmitGuard,
} from "../components/formSupport.tsx";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { isoDay, untilLabel } from "../fmt.ts";
import { Seg } from "../hud/Seg.tsx";
import { BuildChips } from "./buildStatus.tsx";
import {
  closeAway,
  pushOverlay,
  trapTab,
  useAwayOpen,
  useOverlay,
  useReturnFocus,
} from "./overlays.ts";
import { toast } from "./Toast.tsx";
import "./AwayModal.css";

/** Confirmation for settings enforced by the hub. */
export const AWAY_SAVED = "Saved. Away mode gates starts and PR readiness now.";
/** Turning On with no date needs the operator's timezone; until it loads, the press says so. */
export const AWAY_WAITING =
  "Still loading your timezone, which sets the end date. Try again in a moment, or pick an end date first.";
/** How long Away mode runs when turned on with no date. */
const DEFAULT_AWAY_DAYS = 10;

const MAY: { key: keyof AwaySettings["may"]; label: string }[] = [
  {
    key: "pickUp",
    label: "Pick up safe tickets from Ready, one fresh run per ticket on its own branch",
  },
  {
    key: "research",
    label: "Research new tickets and reports, and draft findings for each ticket (coming later)",
  },
  {
    key: "check",
    label: "Check GitHub and Teams every 30 min for anything about me or my tickets (coming later)",
  },
  { key: "status", label: "Keep my tickets' Status in line with the work (my tickets only)" },
  {
    key: "safePr",
    label:
      "Take a safe PR out of draft after the diff, CI and RETRO checks (merge-autonomy repos with explicit hard rules and ticket pickup on)",
  },
];

const ALWAYS = [
  "Automatic starts are safe tickets only. FLIGHT may explicitly start other tickets, which stay in draft, with a walkthrough brief for your return",
  "Comments and nudges are drafted and wait for your return",
  "Never merges, never posts, never changes settings, migrations or another team's code",
];

const SAFE = [
  "Sized XS or S, and a bug, chore, test or docs ticket (labels or issue types, mapped per repo)",
  "Bug: a reproducing test fails on the base commit and passes on the branch",
  "Test: only test files change, and the new tests pass",
  "Docs: only documentation changes",
  "Chore: no change in behaviour; the existing tests prove it",
  "Every type: inside one agent's area; no migrations, settings, CI, infrastructure, dependencies, auth or public API; no existing test edited",
  "Full suite (on the host, or in CI where the host can't run it) and typecheck green, and RETRO finds nothing (with a browser check if a page changed)",
];

const LIMITS = [
  "Keep 30% of every weekly quota window in reserve",
  "At most 4 agents at once",
  "Start nothing new while memory is above 80%",
  "Park a ticket after 2 failed verify rounds and leave it for you",
];

const ON_OFF = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const;

/** A date field's value: empty (until you turn it off), or a real calendar day as YYYY-MM-DD. */
const validDay = (value: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
};

/** Shown under the Until field when the browser could not read what was typed. */
export const AWAY_BAD_DATE =
  "Enter a real date, or clear the field to stay away until you turn it off.";

/**
 * Away mode (catalogue §2.8): what Mission Control may do while the operator is away, saved as one
 * record. The form edits a draft; nothing is sent until Save, and the draft survives a failed save.
 */
export function AwayModal() {
  const open = useAwayOpen();
  const guard = useSubmitGuard();
  // While a save is out the modal stays: closing would drop the draft a failure must keep. Esc
  // pops the overlay before calling this, so it goes back on the stack.
  const dismiss = (): void => {
    if (guard.pending()) pushOverlay("away", dismiss);
    else closeAway();
  };
  useOverlay("away", open, dismiss);
  const head = useId();
  const untilId = useId();
  const close = useRef<HTMLButtonElement>(null);
  useReturnFocus(open);
  useEffect(() => {
    if (open) close.current?.focus();
  }, [open]);

  const tz = useTz();
  const server = useResource<AwaySettings>(RESOURCES.away).data;
  // What the operator has changed and not saved. Null until the first change, so the form follows
  // the server's copy while untouched; once edited it stays put, whatever a refetch brings.
  const [draft, setDraft] = useState<AwaySettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [badDate, setBadDate] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  // Cleared on open as well as close, so a draft left by a save that ended while closed is not shown.
  useEffect(() => {
    setDraft(null);
    setFailure(null);
    setUncertain(false);
    setBadDate(false);
    setAttempted(false);
  }, [open]);

  const away = draft ?? server;
  if (!open) return null;

  const defaultUntil = tz ? isoDay(Date.now(), tz, DEFAULT_AWAY_DAYS) : "";
  // Half-typed input reports an empty value: leave it alone rather than put the default back.
  const shownUntil = !away || badDate ? "" : away.until || (away.on ? "" : defaultUntil);
  const dateError =
    away && (badDate || !(shownUntil === "" || validDay(shownUntil))) ? AWAY_BAD_DATE : undefined;
  const issues: FieldIssue[] = attempted && dateError ? [{ id: untilId, message: dateError }] : [];
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(server);

  const edit = (next: AwaySettings): void => {
    setDraft(next);
    setFailure(null);
    setUncertain(false);
  };

  const onMessage = (until: string): string =>
    `Away mode on ${untilLabel(until)}. Safe tickets can reach ready for review; others stay in draft, and comments wait for you.`;

  function setOn(on: boolean): void {
    if (!away || on === away.on) return;
    if (!on) {
      edit({ ...away, on: false });
      return;
    }
    // no date yet: ten days from today, in the operator's zone (nothing to compute while it loads)
    const until = away.until || (tz ? isoDay(Date.now(), tz, DEFAULT_AWAY_DAYS) : null);
    if (until === null) {
      toast(AWAY_WAITING);
      return;
    }
    setBadDate(false);
    edit({ ...away, on: true, until });
  }

  async function submit(): Promise<void> {
    if (!away || !guard.take()) return;
    if (dateError) {
      guard.release();
      setAttempted(true);
      setFocusKey((key) => key + 1);
      return;
    }
    const next = away;
    setAttempted(false);
    setBusy(true);
    setFailure(null);
    setUncertain(false);
    try {
      await apiPost<AwaySettings>(ACTIONS.away, next);
      const message = !server
        ? null
        : next.on
          ? !server.on || next.until !== server.until
            ? onMessage(next.until)
            : null
          : server.on
            ? "Away mode off. Everything waits for you as usual."
            : null;
      toast(message === null ? AWAY_SAVED : `${message} ${AWAY_SAVED}`);
      setDraft(next);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
      setUncertain(isUncertain(err instanceof ApiError ? err.status : undefined));
      setFocusKey((key) => key + 1);
    } finally {
      // The server may have acted before the answer was lost: read what is saved.
      hub.refetch(RESOURCES.away.path);
      guard.release();
      setBusy(false);
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop takes focus from a click, so Tab stays trapped
    <div className="modal" tabIndex={-1} onKeyDown={trapTab}>
      <form
        className="panel awaypanel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={head}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="ph">
          <h2 id={head}>Away mode</h2>
          <span className="sub">
            Mission Control keeps going while you're away, inside these limits
          </span>
          <BuildChips panel="awayBody" />
          <span className="act">
            <button type="button" className="sm" ref={close} disabled={busy} onClick={dismiss}>
              Close
            </button>
          </span>
        </div>
        <div className="pb scroll fform" id="awayBody">
          {away === undefined ? (
            <p className="note">Loading away mode…</p>
          ) : (
            <>
              <ErrorSummary
                title="Away mode was not saved"
                issues={issues}
                message={failure}
                focusKey={focusKey}
              >
                {uncertain && <p className="s">{UNCERTAIN_TEXT}</p>}
              </ErrorSummary>
              <fieldset className="fgroup fform-480 awayctl">
                <legend>When</legend>
                <div className="ffield">
                  <span className="s fg2">Away mode</span>
                  <Seg
                    label="Away mode"
                    options={ON_OFF}
                    value={away.on ? "on" : "off"}
                    onChange={(v) => setOn(v === "on")}
                  />
                </div>
                <div className="ffield">
                  <label htmlFor={untilId}>Until</label>
                  <input
                    {...fieldProps(untilId, dateError, `${untilId}-hint`)}
                    type="date"
                    value={shownUntil}
                    onChange={(e) => {
                      setBadDate(e.target.validity.badInput);
                      edit({ ...away, until: e.target.value });
                    }}
                  />
                  <span id={`${untilId}-hint`} className="fhint muted xs">
                    The last day away mode runs, in your timezone. Clear it to stay away until you
                    turn it off.
                  </span>
                  <FieldError id={untilId} error={dateError} />
                </div>
                <p className="s fg2" role="status">
                  {server?.on
                    ? `Away mode is on ${untilLabel(server.until)}.`
                    : "Off: everything waits for you as usual."}
                  {dirty ? " Unsaved changes." : ""}
                </p>
              </fieldset>
              <div className="awaygrid">
                <div>
                  <h3>While I'm away, Mission Control may</h3>
                  <div className="swlist">
                    {MAY.map(({ key, label }) => (
                      <label className="sw" key={key}>
                        <input
                          type="checkbox"
                          checked={away.may[key]}
                          onChange={(e) =>
                            edit({ ...away, may: { ...away.may, [key]: e.target.checked } })
                          }
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                    {ALWAYS.map((line) => (
                      <div className="sw locked" key={line}>
                        <span>{line}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <h3>A ticket counts as safe when</h3>
                  <ul className="rules">
                    {SAFE.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <p className="note xs">
                    Label safe-to-merge and ask its code owner to review: coming later.
                  </p>
                  <h3 className="gap">Limits</h3>
                  <ul className="rules">
                    {LIMITS.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3>When you come back</h3>
                  <p className="s gap">One digest, most urgent first.</p>
                  <p className="note xs">
                    Need you now; safe PRs ready for review; drafts to walk through; failed, with
                    the reason; decisions FLIGHT made, with reasons; messages drafted for you.
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
        {away !== undefined && (
          <div className="pfoot fact">
            <button type="submit" className="sm" disabled={busy}>
              Save away mode
            </button>
            <button type="button" className="sm" disabled={busy} onClick={dismiss}>
              Cancel
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
