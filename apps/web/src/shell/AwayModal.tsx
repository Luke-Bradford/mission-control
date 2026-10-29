import type { AwaySettings } from "@mc/core";
import { useEffect, useId, useRef, useState } from "react";
import { apiPost } from "../api.ts";
import { useTz } from "../clock.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { isoDay, untilLabel } from "../fmt.ts";
import { Seg } from "../hud/Seg.tsx";
import { BuildChips } from "./buildStatus.tsx";
import { closeAway, trapTab, useAwayOpen, useOverlay, useReturnFocus } from "./overlays.ts";
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

/** Away mode (catalogue §2.8): what Mission Control may do while the operator is away, saved as one record. */
export function AwayModal() {
  const open = useAwayOpen();
  useOverlay("away", open, closeAway);
  const head = useId();
  const untilId = useId();
  const close = useRef<HTMLButtonElement>(null);
  useReturnFocus(open);
  useEffect(() => {
    if (open) close.current?.focus();
  }, [open]);

  const tz = useTz();
  const server = useResource<AwaySettings>(RESOURCES.away).data;
  // What was just changed and is still being saved: shown until the server's copy arrives, or the
  // save fails and the page goes back to the server's copy.
  const [pending, setPending] = useState<AwaySettings | null>(null);
  const saving = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `server` is the trigger, not a value read: a fresh copy from the server ends the optimistic one
  useEffect(() => {
    if (saving.current === 0) setPending(null);
  }, [server]);

  const away = pending ?? server;
  if (!open) return null;

  function save(next: AwaySettings, message: string | null): void {
    setPending(next);
    saving.current++;
    apiPost<AwaySettings>(ACTIONS.away, next).then(
      () => {
        saving.current--;
        toast(message === null ? AWAY_SAVED : `${message} ${AWAY_SAVED}`);
        hub.refetch(RESOURCES.away.path);
      },
      (err: unknown) => {
        saving.current--;
        if (saving.current === 0) setPending(null);
        toast(`Could not save away mode: ${err instanceof Error ? err.message : String(err)}`);
        hub.refetch(RESOURCES.away.path);
      },
    );
  }

  const onMessage = (until: string): string =>
    `Away mode on ${untilLabel(until)}. Safe tickets can reach ready for review; others stay in draft, and comments wait for you.`;

  function setOn(on: boolean): void {
    if (!away || on === away.on) return;
    if (!on) {
      save({ ...away, on: false }, "Away mode off. Everything waits for you as usual.");
      return;
    }
    // no date yet: ten days from today, in the operator's zone (nothing to compute while it loads)
    const until = away.until || (tz ? isoDay(Date.now(), tz, DEFAULT_AWAY_DAYS) : null);
    if (until === null) {
      toast(AWAY_WAITING);
      return;
    }
    save({ ...away, on: true, until }, onMessage(until));
  }

  function setUntil(until: string): void {
    if (!away) return;
    save({ ...away, until }, away.on ? onMessage(until) : null);
  }

  const defaultUntil = tz ? isoDay(Date.now(), tz, DEFAULT_AWAY_DAYS) : "";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop takes focus from a click, so Tab stays trapped
    <div className="modal" tabIndex={-1} onKeyDown={trapTab}>
      <div className="panel awaypanel" role="dialog" aria-modal="true" aria-labelledby={head}>
        <div className="ph">
          <h2 id={head}>Away mode</h2>
          <span className="sub">
            Mission Control keeps going while you're away, inside these limits
          </span>
          <BuildChips panel="awayBody" />
          <span className="act">
            <button type="button" className="sm" ref={close} onClick={closeAway}>
              Close
            </button>
          </span>
        </div>
        <div className="pb scroll" id="awayBody">
          {away === undefined ? (
            <p className="note">Loading away mode…</p>
          ) : (
            <>
              <div className="row awayctl">
                <Seg
                  label="Away mode"
                  options={ON_OFF}
                  value={away.on ? "on" : "off"}
                  onChange={(v) => setOn(v === "on")}
                />
                <label className="s fg2" htmlFor={untilId}>
                  Until
                </label>
                <input
                  type="date"
                  id={untilId}
                  value={away.until || (away.on ? "" : defaultUntil)}
                  onChange={(e) => setUntil(e.target.value)}
                />
                <span className="s fg2" role="status">
                  {away.on
                    ? `Away mode is on ${untilLabel(away.until)}.`
                    : "Off: everything waits for you as usual."}
                </span>
              </div>
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
                            save({ ...away, may: { ...away.may, [key]: e.target.checked } }, null)
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
      </div>
    </div>
  );
}
