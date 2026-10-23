import { errorText } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import { ACTIONS } from "../data.ts";
import {
  type BoardSetupResult,
  type BoardSetupStatus,
  CREATE_LABELS,
  confirmText,
  isReady,
  mismatchLine,
  resultLines,
  SET_UP_BOARD,
  statusLines,
} from "./boardSetup.ts";

/** Where focus goes once the control that held it is gone or busy. */
type FocusNext = "trigger" | "recheck";

/**
 * A repo's board setup. The status is read on demand: each read is a GitHub call, so it is not made
 * once per repo on every page load. The setup writes to GitHub, so it asks first.
 */
export function BoardSetup({ repoId, github }: { repoId: string; github: string }) {
  const [status, setStatus] = useState<BoardSetupStatus | null>(null);
  const [result, setResult] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusNext, setFocusNext] = useState<FocusNext | null>(null);
  const confirmRef = useRef<HTMLParagraphElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const recheckRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (focusNext === null || busy) return;
    (focusNext === "trigger" ? triggerRef : recheckRef).current?.focus();
    setFocusNext(null);
  }, [focusNext, busy]);

  async function read() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await apiGet<BoardSetupStatus>(ACTIONS.boardSetup(repoId)));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function setUp() {
    setBusy(true);
    setError(null);
    setResult([]);
    setConfirming(false);
    setFocusNext("recheck");
    try {
      setResult(resultLines(await apiPost<BoardSetupResult>(ACTIONS.boardSetup(repoId))));
    } catch (err) {
      setError(errorText(err));
    }
    // Read again even after a failure: fields may have been created before the error.
    try {
      setStatus(await apiGet<BoardSetupStatus>(ACTIONS.boardSetup(repoId)));
    } catch (err) {
      setError((prev) => prev ?? errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={`Board setup for ${repoId}`}>
      <div aria-live="polite">
        {status !== null &&
          statusLines(status).map((line) => (
            <p key={line} className="s">
              {line}
            </p>
          ))}
        {status?.mismatched.map((m) => (
          <p key={m.field} className="s">
            {mismatchLine(m)}
          </p>
        ))}
        {result.map((line, i) => (
          // The lines are not reordered; the index only separates two equal lines.
          // biome-ignore lint/suspicious/noArrayIndexKey: stable list, index plus text
          <p key={`${i}:${line}`} className="s">
            {line}
          </p>
        ))}
      </div>
      {status === null ? (
        <button type="button" disabled={busy} onClick={() => void read()}>
          Check board
        </button>
      ) : (
        <>
          {!confirming && !isReady(status) && (
            <button
              ref={triggerRef}
              type="button"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              {status.missing.length > 0 ? SET_UP_BOARD : CREATE_LABELS}
            </button>
          )}{" "}
          {confirming && !isReady(status) && (
            <>
              <p ref={confirmRef} tabIndex={-1} className="note">
                {confirmText(github, status)}
              </p>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void setUp()}
              >
                Create on GitHub
              </button>{" "}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  setFocusNext("trigger");
                }}
              >
                Cancel
              </button>{" "}
            </>
          )}
          <button ref={recheckRef} type="button" disabled={busy} onClick={() => void read()}>
            Recheck
          </button>
        </>
      )}
      {error !== null && (
        <p role="alert" className="crit-t s">
          {error}
        </p>
      )}
    </section>
  );
}
