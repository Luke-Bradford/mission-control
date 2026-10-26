import type { CliAccountStatus, ConfigView, CrewChanges, CrewRow, LimitRow } from "@mc/core";
import { type CSSProperties, useRef, useState } from "react";
import { apiPost } from "../api.ts";
import { useTz } from "../clock.ts";
import { PauseButton } from "../components/PauseButton.tsx";
import { callSign, modelLine, seatAreaText, seatStatus, seatTurn } from "../crew.ts";
import { ACTIONS, hub, RESOURCES, useResource, useReviewPrs } from "../data.ts";
import { agentColor, useRoleLabel } from "../hud/AgentTag.tsx";
import { DoingLine } from "../hud/DoingLine.tsx";
import { Pill } from "../hud/Pill.tsx";
import { agentPath } from "../router.ts";
import { BuildChips } from "../shell/buildStatus.tsx";
import { useIsPopout } from "../shell/popout.ts";
import { toast } from "../shell/Toast.tsx";
import { endConfirm, endSeat, interruptSeat, seatError } from "./seat.ts";
import { Tiles } from "./Tiles.tsx";

/** The agent in its own window (`?popout=1`: the Agent page alone), one window per agent. */
const popOut = (id: string): void => {
  window.open(`${agentPath(id)}?popout=1`, `mc-agent-${id}`, "popup,width=1200,height=820");
};

/**
 * Interrupt and End the run for a crew seat with a live session. `interrupt` false leaves Interrupt
 * out, where the row's need line already carries one.
 */
export function SeatControls({
  row,
  interrupt = true,
  hold = false,
}: {
  row: CrewRow;
  interrupt?: boolean;
  hold?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turn = seatTurn(row);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(seatError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {error && (
        <span className="crit-t s" role="alert">
          {error}
        </span>
      )}
      {interrupt && turn === "running" && (
        <button
          type="button"
          className={row.hudState === "stalled" ? "sm warn" : "sm"}
          disabled={busy}
          onClick={() => run(() => interruptSeat(row))}
        >
          Interrupt
        </button>
      )}
      {turn !== "none" && (
        <button
          type="button"
          className="sm warn"
          disabled={busy}
          onClick={() => {
            if (window.confirm(endConfirm(row, hold))) void run(() => endSeat(row, hold));
          }}
        >
          {hold ? "Stop" : "End the run"}
        </button>
      )}
    </>
  );
}

function RenameSeat({ row }: { row: CrewRow }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const changes = useResource<CrewChanges>(editing ? RESOURCES.crewChanges : null);
  const base = changes.data?.sessions.find((s) => s.id === row.sessionId)?.seats;
  const inConfig = base?.some((s) => s.id === row.id);
  const close = () => {
    setEditing(false);
    button.current?.focus();
  };
  const save = async () => {
    if (busy || !base || !inConfig || row.sessionId === null) return;
    if (name.length > 64 || !name.trim() || /\p{Cc}/u.test(name)) {
      setError("Use 1–64 characters, with no control characters or blank call sign.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost(ACTIONS.crewSeats(row.sessionId), {
        base,
        seats: base.map((s) => (s.id === row.id ? { ...s, displayCallSign: name } : s)),
      });
      close();
    } catch (e) {
      setError(seatError(e));
    } finally {
      hub.refetch(RESOURCES.crewChanges.path);
      hub.refetch(RESOURCES.config.path);
      hub.refetch(RESOURCES.crew.path);
      setBusy(false);
    }
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className="sm ghost"
        disabled={busy}
        aria-expanded={editing}
        onClick={() => {
          if (editing) return;
          setName(callSign(row));
          setError(null);
          setEditing(true);
          toast(
            `Rename ${callSign(row)}: call signs default to the role's console plus a number. Any name works.`,
          );
        }}
      >
        Rename
      </button>
      {editing && (
        <form
          className="rename-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (!busy) close();
            }
          }}
        >
          <label>
            Call sign
            <input
              // biome-ignore lint/a11y/noAutofocus: focus the editor opened by the Rename button
              autoFocus
              value={name}
              disabled={busy}
              aria-invalid={!!error}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
          </label>
          <button type="submit" className="sm" disabled={busy || !inConfig}>
            Save call sign
          </button>
          <button type="button" className="sm ghost" disabled={busy} onClick={close}>
            Cancel
          </button>
          {changes.loading && !changes.data && <span className="s muted">Loading call sign…</span>}
          {!changes.loading && !changes.error && !inConfig && (
            <span className="s muted">Not in config.yaml</span>
          )}
          {(error || changes.error) && (
            <span className="crit-t s" role="alert">
              {error ?? changes.error?.message}
            </span>
          )}
        </form>
      )}
    </>
  );
}

function SwitchAccount({ row }: { row: CrewRow }) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const config = useResource<ConfigView>(RESOURCES.config);
  const statuses = useResource<CliAccountStatus[]>(open ? RESOURCES.accountStatus : null);
  const provider = config.data?.accounts.find((a) => a.id === row.accountId)?.vendor;
  // Transfers currently require independently logged-in Codex bindings; the server validates them.
  const accounts = (config.data?.accounts ?? []).filter(
    (a) => a.id !== row.accountId && a.vendor === provider && provider === "codex",
  );
  const reading = statuses.data?.find((s) => s.accountId === accountId);
  const loadError = config.error ?? statuses.error;
  const loading = config.loading || statuses.loading;
  const available =
    accounts.some((a) => a.id === accountId) &&
    reading?.provider === provider &&
    reading?.status === "logged-in" &&
    !loadError &&
    !loading &&
    !checking &&
    !checkFailed;
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const retry = async () => {
    if (checking) return;
    setChecking(true);
    setCheckFailed(false);
    setError(null);
    try {
      await Promise.all(accounts.map((a) => apiPost<CliAccountStatus>(ACTIONS.checkAccount(a.id))));
    } catch (e) {
      setCheckFailed(true);
      setError(seatError(e));
    } finally {
      hub.refetch(RESOURCES.config.path);
      hub.refetch(RESOURCES.accountStatus.path);
      setChecking(false);
    }
  };
  const transfer = async () => {
    if (busy || !available) return;
    setBusy(true);
    setError(null);
    setResult("");
    try {
      const response = await apiPost<{ outcome: "resumed" | "fresh" | "refused"; reason?: string }>(
        ACTIONS.seatTransfer(row.id),
        { accountId },
      );
      if (response.outcome === "refused")
        setError(`Transfer refused: ${response.reason ?? "No reason supplied"}`);
      else if (response.outcome === "resumed")
        setResult(`${callSign(row)}: resumed on ${accountId}.`);
      else if (response.outcome === "fresh")
        setResult(`${callSign(row)}: started fresh on ${accountId} with a handoff brief.`);
      else setError("Transfer returned an unexpected response. Refresh and try again.");
    } catch (e) {
      setError(seatError(e));
    } finally {
      hub.refetch(RESOURCES.accountStatus.path);
      hub.refetch(RESOURCES.config.path);
      hub.refetch(RESOURCES.crew.path);
      setBusy(false);
    }
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className="sm"
        aria-expanded={open}
        disabled={busy || !provider}
        onClick={() => {
          if (open) return;
          setAccountId("");
          setResult("");
          setError(null);
          setOpen(true);
          hub.refetch(RESOURCES.accountStatus.path);
          toast(
            `${callSign(row)}: pick another ${provider} account. Mission Control moves the session there and resumes it, or starts fresh with a handoff brief if the resume fails.`,
          );
        }}
      >
        Switch account
      </button>
      {!open && config.error && (
        <span className="s crit-t" role="alert">
          {config.error.message}{" "}
          <button
            type="button"
            className="sm ghost"
            onClick={() => hub.refetch(RESOURCES.config.path)}
          >
            Retry accounts
          </button>
        </span>
      )}
      {open && (
        <form
          className="account-chooser"
          aria-label="Switch account"
          onSubmit={(e) => {
            e.preventDefault();
            void transfer();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (!busy && !checking) close();
            }
          }}
        >
          <label>
            Account
            <select
              // biome-ignore lint/a11y/noAutofocus: focus the chooser opened by the Switch account button
              autoFocus
              value={accountId}
              disabled={busy || checking || !!loadError}
              onChange={(e) => {
                setAccountId(e.target.value);
                setError(null);
                setResult("");
              }}
            >
              <option value="">Choose account</option>
              {accounts.map((a) => {
                const status = statuses.data?.find((s) => s.accountId === a.id)?.status;
                return (
                  <option key={a.id} value={a.id}>
                    {a.id} ·{" "}
                    {status === "logged-in"
                      ? "Available"
                      : status === "not-logged-in"
                        ? "Not signed in"
                        : "Availability unknown"}
                  </option>
                );
              })}
            </select>
          </label>
          <button type="submit" className="sm" disabled={busy || !available}>
            Transfer account
          </button>
          <button type="button" className="sm ghost" disabled={busy || checking} onClick={close}>
            Cancel
          </button>
          {checking && <span className="s muted">Checking accounts…</span>}
          {loading && <span className="s muted">Loading accounts…</span>}
          {!loading && !loadError && accounts.length === 0 && (
            <span className="s muted">No other compatible accounts configured.</span>
          )}
          {accountId && !loading && !loadError && !available && (
            <span className="s muted">
              {reading?.detail} Sign in with the {provider} CLI on this machine, then retry the
              availability check.
            </span>
          )}
          {!busy && (
            <button
              type="button"
              className="sm ghost"
              disabled={checking}
              onClick={() => void retry()}
            >
              Retry
            </button>
          )}
          {(error || loadError) && (
            <span role="alert" className="crit-t s">
              {error ?? loadError?.message}
            </span>
          )}
          {(busy || result) && (
            <span role="status" className="s">
              {busy ? "Transferring account…" : result}
            </span>
          )}
        </form>
      )}
    </>
  );
}

/** Removal uses config.yaml's seat list, including changes that have not applied yet. */
function SeatSettings({ row }: { row: CrewRow }) {
  const removable = row.hudState === "idle" || row.hudState === "stopped";
  const changes = useResource<CrewChanges>(removable ? RESOURCES.crewChanges : null);
  const base = changes.data?.sessions.find((s) => s.id === row.sessionId)?.seats;
  const inConfig = base?.some((s) => s.id === row.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    if (!base || row.sessionId === null) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(ACTIONS.crewSeats(row.sessionId), {
        base,
        seats: base.filter((s) => s.id !== row.id),
      });
      toast(
        `${callSign(row)} removed from s/${row.sessionId}. Its area is freed when its run ends.`,
      );
    } catch (e) {
      setError(seatError(e));
    } finally {
      hub.refetch(RESOURCES.crewChanges.path);
      hub.refetch(RESOURCES.config.path);
      hub.refetch(RESOURCES.crew.path);
      setBusy(false);
    }
  };
  return (
    <>
      {(error || changes.error) && (
        <span className="crit-t s" role="alert">
          {error ?? changes.error?.message}
        </span>
      )}
      {removable && (
        <button
          type="button"
          className="sm"
          disabled={busy || !inConfig}
          onClick={() => {
            if (
              window.confirm(
                `Remove ${callSign(row)} from s/${row.sessionId}? Its area will be freed when its run ends.`,
              )
            )
              void remove();
          }}
        >
          Remove
        </button>
      )}
      {removable && changes.data && !inConfig && (
        <span className="s muted">Not in config.yaml</span>
      )}
      <RenameSeat row={row} />
    </>
  );
}

/**
 * The agent's header (catalogue 2.4.3): id with its colour, state, chips, Pause/Resume for a TA
 * loop only (the loop is observed, so there are no other loop controls) and Pop out. Then the tiles.
 */
export function Header({ row, limits, now }: { row: CrewRow; limits: LimitRow[]; now: number }) {
  const branch = row.run?.branch ?? null;
  const tz = useTz();
  const repoPrs = useReviewPrs(row);
  const popout = useIsPopout();
  const role = useRoleLabel(row.id);
  return (
    <section className="panel ahead" id="ahead" aria-label={`${row.id} details`}>
      <div className="idrow">
        <span
          className="big"
          style={{ "--c": agentColor(row.index) } as CSSProperties}
          title={role.title}
        >
          <i aria-hidden="true" />
          {callSign(row)}
          {role.suffix !== null && <span className="rt">{` · ${role.suffix}`}</span>}
        </span>
        <span title={seatStatus(row).reason ?? seatStatus(row).label}>
          <Pill tone={seatStatus(row).tone}>{seatStatus(row).label}</Pill>
        </span>
        <span className="chips">
          {row.kind === "crew" ? (
            <>
              <span title={row.role ?? undefined}>{row.role}</span>
              <span title={row.mode ?? undefined}>{row.mode}</span>
              <span title={`s/${row.sessionId}`}>s/{row.sessionId}</span>
            </>
          ) : (
            <>
              <span title={`observed loop · ${row.loopKind}`}>observed loop · {row.loopKind}</span>
              <span title={`s/${row.repoId}`}>s/{row.repoId}</span>
            </>
          )}
          <span title={`${row.accountId} · ${modelLine(row)}`}>
            {row.accountId} · {modelLine(row)}
          </span>
          {row.kind === "crew" && (
            <span className="mono" title={`area: ${seatAreaText(row)}`}>
              area: {seatAreaText(row)}
            </span>
          )}
          {branch !== null && (
            <span className="mono" title={branch}>
              {branch}
            </span>
          )}
        </span>
        <BuildChips panel="ahead" />
        <span className="ctl">
          {row.kind === "crew" && (
            <>
              <SeatControls key={`controls:${row.id}`} row={row} hold />
              <SwitchAccount key={`account:${row.id}`} row={row} />
              <SeatSettings key={`settings:${row.id}`} row={row} />
            </>
          )}
          {row.loopKind === "ta-loop" && <PauseButton row={row} />}
          {!popout && (
            <button type="button" className="sm ghost" onClick={() => popOut(row.id)}>
              Pop out
            </button>
          )}
        </span>
      </div>
      <p className="s fg2 doing">
        <DoingLine row={row} now={now} tz={tz} repoPrs={repoPrs} />
      </p>
      {row.kind === "loop" && (
        <p className="s muted">Observed loop: Mission Control reads it and never drives it.</p>
      )}
      <Tiles row={row} limits={limits} now={now} />
    </section>
  );
}
