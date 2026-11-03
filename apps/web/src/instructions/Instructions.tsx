import {
  INSTRUCTION_TEXT_MAX,
  type InstructionMutation,
  type SeatInstructionIndex,
  type SeatInstructionList,
  type StandingInstruction,
  type StandingInstructionList,
} from "@mc/core";
import { useEffect, useId, useRef, useState } from "react";
import { apiPost } from "../api.ts";
import { useTz } from "../clock.ts";
import { Expandable } from "../components/Expandable.tsx";
import {
  ACTIONS,
  hub,
  RESOURCES,
  type Resource,
  type ResourceRef,
  streamStatus,
  useResource,
} from "../data.ts";
import { hhmm } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { agentPath, followLink, useHash } from "../router.ts";
import { store, useStore } from "../shell/store.ts";
import { orderAnchor, orderFromHash } from "./links.ts";
import "./instructions.css";

interface InstructionDraft {
  editing: StandingInstruction | "new" | null;
  revoking: StandingInstruction | null;
  text: string;
  error: string | null;
  notice: string;
  pending: boolean;
  expanded: boolean;
}
const EMPTY_DRAFT: InstructionDraft = {
  editing: null,
  revoking: null,
  text: "",
  error: null,
  notice: "",
  pending: false,
  expanded: false,
};
/** UI drafts only: per-target state survives lazy tab/seat unmounts. Server data stays in hub. */
export const instructionDrafts = store<Record<string, InstructionDraft>>({});

export const INSTRUCTION_HELP =
  "Operator orders outrank memory and seat instructions. Operator seat instructions outrank FLIGHT’s. Repo rules and safety floors still apply.";
export const instructionSource = (entry: StandingInstruction): string =>
  entry.source === "legacy-config"
    ? "Imported from config"
    : entry.by === "operator"
      ? "Operator"
      : "FLIGHT";
export const instructionValue = (entry: StandingInstruction): string =>
  entry.kind === "text"
    ? entry.text
    : entry.focus === null
      ? "Focus cleared · unrestricted"
      : `Focus: ${entry.focus}`;
/** Preview only: the server remains authoritative for focus and queue eligibility. */
export const nextFocus = (
  entries: readonly StandingInstruction[],
  removed?: number,
): StandingInstruction | undefined =>
  entries
    .filter((entry) => entry.id !== removed && entry.revokedAt === null && entry.kind === "focus")
    .sort((a, b) => Number(a.by !== "operator") - Number(b.by !== "operator") || b.id - a.id)[0];

export function refreshInstructions(): void {
  hub.refetchTopic("flight");
  hub.refetchTopic("config");
  hub.refetchTopic("agents");
}

export function InstructionReadState<T>({
  resource,
  reference,
  name,
}: {
  resource: Resource<T>;
  reference: ResourceRef;
  name: string;
}) {
  const connection = useStore(streamStatus);
  return (
    <>
      {!connection.connected && connection.reconnecting && (
        <p className="note" role="status">
          Disconnected.{" "}
          {resource.data === undefined ? `Cannot refresh ${name}.` : `Showing saved ${name}.`}{" "}
          Reconnect to refresh.
        </p>
      )}
      {resource.error && (
        <p className="note err" role="alert">
          {resource.data === undefined
            ? `Could not load ${name}`
            : `Showing saved ${name}; refresh failed`}
          : {resource.error.message}{" "}
          <button className="sm" type="button" onClick={() => hub.refetch(reference.path)}>
            Retry {name}
          </button>
        </p>
      )}
      {resource.data === undefined && !resource.error && (
        <p className="note" role="status">
          Loading {name}…
        </p>
      )}
    </>
  );
}

function Entry({
  entry,
  onEdit,
  onRevoke,
  anchored = false,
  disabled = false,
}: {
  entry: StandingInstruction;
  onEdit?: (entry: StandingInstruction, button: HTMLButtonElement) => void;
  onRevoke?: (entry: StandingInstruction, button: HTMLButtonElement) => void;
  anchored?: boolean;
  disabled?: boolean;
}) {
  const tz = useTz();
  const queueHref = entry.seatId === null ? null : `${agentPath(entry.seatId)}?side=queue`;
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    if (anchored) {
      box.current?.focus();
      box.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [anchored]);
  const date = (at: number) =>
    tz === null
      ? new Date(at).toISOString()
      : `${new Date(at).toLocaleDateString("en-GB", { timeZone: tz })} ${hhmm(at, tz)}`;
  return (
    <article
      className="instruction-row"
      id={anchored ? orderAnchor(entry.id) : undefined}
      ref={box}
      aria-label={`Instruction #${entry.id}`}
      tabIndex={anchored ? -1 : undefined}
    >
      <div className="instruction-meta">
        <b>
          #{entry.id} · {entry.seatId ?? "Global FLIGHT order"}
        </b>
        <span>{entry.revokedAt === null ? "Active" : "Revoked"}</span>
      </div>
      <p className="note">
        {instructionSource(entry)} · {entry.source === "legacy-config" ? "imported" : "saved"}{" "}
        {date(entry.at)}
        {entry.revokedAt !== null && ` · revoked ${date(entry.revokedAt)}`}
      </p>
      <Expandable lines={4} of={`instruction #${entry.id}`}>
        <section
          className="instruction-text"
          aria-label={`Full instruction #${entry.id}`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: expanded full text needs native keyboard scrolling.
          tabIndex={0}
        >
          {instructionValue(entry)}
        </section>
      </Expandable>
      {entry.revokedAt === null && (
        <div className="instruction-actions">
          {onEdit && entry.kind === "text" && (
            <button
              type="button"
              className="sm"
              disabled={disabled}
              onClick={(e) => onEdit(entry, e.currentTarget)}
            >
              Replace #{entry.id}
            </button>
          )}
          {entry.kind === "focus" && queueHref !== null && (
            <a
              className="sm instruction-link"
              href={queueHref}
              onClick={(e) => followLink(e, queueHref)}
            >
              Change focus in Queue
            </a>
          )}
          {onRevoke && (
            <button
              type="button"
              className="sm warn"
              disabled={disabled}
              onClick={(e) => onRevoke(entry, e.currentTarget)}
            >
              Revoke #{entry.id}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/** One history page subscribes only while its disclosure is open. Pagination never caps active rows. */
function History({
  seatId,
  before,
  onPage,
}: {
  seatId: string | null;
  before?: number;
  onPage: (cursor: number | undefined) => void;
}) {
  const reference = RESOURCES.instructionHistory(seatId, before);
  const history = useResource<StandingInstructionList>(reference);
  return (
    <>
      <InstructionReadState resource={history} reference={reference} name="instruction history" />
      {history.data && (
        <>
          {history.data.history.length === 0 && (
            <p className="note">No revoked instructions on this page.</p>
          )}
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: named history scroll region needs keyboard access. */}
          <section className="instruction-list" aria-label="Revoked instructions" tabIndex={0}>
            {history.data.history.map((entry) => (
              <Entry entry={entry} key={entry.id} />
            ))}
          </section>
          <div className="instruction-actions">
            {before !== undefined && (
              <button className="sm" type="button" onClick={() => onPage(undefined)}>
                Newest history
              </button>
            )}
            {history.data.nextCursor !== null && (
              <button
                className="sm"
                type="button"
                disabled={history.loading}
                onClick={() => onPage(history.data?.nextCursor ?? undefined)}
              >
                Older history
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

/** The operator edits text here. Selectors keep their existing single Queue editor. */
export function InstructionManager({ seatId }: { seatId: string | null }) {
  const reference = seatId === null ? RESOURCES.flightOrders : RESOURCES.seatInstructions(seatId);
  const resource = useResource<SeatInstructionList | StandingInstructionList>(reference);
  const hash = useHash();
  const selectedId = seatId === null ? orderFromHash(hash) : null;
  const selectedRef = selectedId === null ? null : RESOURCES.retainedOrder(selectedId);
  const selected = useResource<StandingInstruction>(selectedRef);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [before, setBefore] = useState<number | undefined>();
  const targetKey = seatId === null ? "global" : `seat:${seatId}`;
  const currentDraft = useStore(instructionDrafts)[targetKey] ?? EMPTY_DRAFT;
  const updateDraft = (patch: Partial<InstructionDraft>) => {
    const all = instructionDrafts.get();
    instructionDrafts.set({
      ...all,
      [targetKey]: { ...(all[targetKey] ?? EMPTY_DRAFT), ...patch },
    });
  };
  const { editing, revoking, text: draft, error, notice, pending: busy } = currentDraft;
  const setEditing = (editing: InstructionDraft["editing"]) => updateDraft({ editing });
  const setRevoking = (revoking: InstructionDraft["revoking"]) => updateDraft({ revoking });
  const setDraft = (text: string) => updateDraft({ text });
  const setError = (error: string | null) => {
    updateDraft({ error });
    if (error !== null) requestAnimationFrame(() => errorBox.current?.focus());
  };
  const setNotice = (notice: string) => updateDraft({ notice });
  const setBusy = (pending: boolean) => updateDraft({ pending });
  const errorBox = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const restore = useRef<HTMLButtonElement | null>(null);
  const add = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(editing !== null || revoking !== null);
  const formId = useId();
  useEffect(() => {
    if (revoking) confirm.current?.focus();
  }, [revoking]);
  useEffect(() => {
    if (editing !== null || revoking !== null) wasOpen.current = true;
    else if (!busy && wasOpen.current) {
      wasOpen.current = false;
      (restore.current?.isConnected ? restore.current : add.current)?.focus();
    }
  }, [editing, revoking, busy]);
  useEffect(() => {
    if (selected.data?.revokedAt !== null && selected.data !== undefined) setHistoryOpen(true);
  }, [selected.data]);
  useEffect(() => {
    if (editing !== null) editor.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (error) errorBox.current?.focus();
  }, [error]);
  const close = () => {
    setEditing(null);
    setRevoking(null);
    setError(null);
    requestAnimationFrame(() =>
      (restore.current?.isConnected ? restore.current : add.current)?.focus(),
    );
  };
  const edit = (entry: StandingInstruction | "new", button: HTMLButtonElement) => {
    restore.current = button;
    setEditing(entry);
    setRevoking(null);
    setDraft(entry !== "new" && entry.kind === "text" ? entry.text : "");
    setError(null);
    setNotice("");
  };
  const revoke = (entry: StandingInstruction, button: HTMLButtonElement) => {
    restore.current = button;
    setRevoking(entry);
    setEditing(null);
    setError(null);
    setNotice("");
  };
  const mutate = async (action: "save" | "revoke") => {
    if (instructionDrafts.get()[targetKey]?.pending) return;
    if (action === "save" && (!draft.trim() || draft.trim().length > INSTRUCTION_TEXT_MAX)) {
      setError(
        `Instruction text must contain 1 to ${INSTRUCTION_TEXT_MAX} characters. Your draft is retained.`,
      );
      return;
    }
    if (action === "revoke" && revoking === null) return;
    setBusy(true);
    setError(null);
    try {
      const request =
        action === "save"
          ? {
              path: ACTIONS.saveInstruction(seatId),
              body: {
                ...(seatId === null ? {} : { kind: "text" }),
                text: draft,
                ...(editing !== null && editing !== "new" ? { replacesId: editing.id } : {}),
              },
            }
          : revoking === null
            ? null
            : { path: ACTIONS.revokeInstruction(seatId, revoking.id), body: {} };
      if (request === null) return;
      const result = await apiPost<InstructionMutation>(request.path, request.body);
      setNotice(
        `Instruction #${result.entry.id} ${action === "save" ? "saved" : "revoked"}.${result.delivery === "pending" ? " Notification pending; saved guidance is retained." : result.delivery === "inbox" ? " Notice saved in the seat’s inbox." : ""}`,
      );
      refreshInstructions();
      restore.current = null;
      close();
    } catch (failure) {
      setError(
        `${failure instanceof Error ? failure.message : String(failure)} Your draft and target are retained; retry when ready.`,
      );
    } finally {
      setBusy(false);
    }
  };
  const active = resource.data?.active ?? [];
  const focus = resource.data && "effectiveFocus" in resource.data ? resource.data : null;
  const source =
    focus?.focusInstructionId === null
      ? undefined
      : active.find((entry) => entry.id === focus?.focusInstructionId);
  const afterRevoke = revoking?.kind === "focus" ? nextFocus(active, revoking.id) : undefined;
  return (
    <div className="instruction-manager">
      <InstructionReadState
        resource={resource}
        reference={reference}
        name={seatId === null ? "orders" : "seat instructions"}
      />
      <p className="note">{INSTRUCTION_HELP}</p>
      {focus && (
        <>
          <p className="note">
            <b>Effective focus:</b>{" "}
            {source
              ? `${source.kind === "focus" && source.focus === null ? "explicit clear · " : ""}${instructionSource(source)} #${source.id}`
              : "No saved focus"}
          </p>
          <Expandable lines={3} of="effective focus">
            <span className="instruction-text">{focus.effectiveFocus ?? "Unrestricted"}</span>
          </Expandable>
          <p className="note">
            Clear in Queue saves an operator instruction. Revoking it can reveal FLIGHT’s focus.
          </p>
        </>
      )}
      {notice && (
        <p role="status" className="note">
          {notice}
        </p>
      )}
      <button
        type="button"
        className="sm"
        ref={add}
        disabled={resource.data === undefined || busy || editing !== null || revoking !== null}
        onClick={(e) => edit("new", e.currentTarget)}
      >
        {seatId === null ? "Add order" : "Add seat instruction"}
      </button>
      {seatId !== null && (
        <a
          className="instruction-link"
          href={`${agentPath(seatId)}?side=queue`}
          onClick={(e) => followLink(e, `${agentPath(seatId)}?side=queue`)}
        >
          Edit focus or Clear in Queue
        </a>
      )}
      {error && (
        <div
          className="note err"
          role="alert"
          ref={errorBox}
          tabIndex={-1}
          aria-label="Instruction action failed"
        >
          {error}{" "}
          {editing !== null && (
            <a
              href={`#${formId}`}
              onClick={(event) => {
                event.preventDefault();
                editor.current?.focus();
              }}
            >
              Return to Instruction text
            </a>
          )}
        </div>
      )}
      {editing !== null && (
        <form
          className="instruction-form"
          aria-label={editing === "new" ? "Add instruction" : `Replace instruction #${editing.id}`}
          onSubmit={(e) => {
            e.preventDefault();
            void mutate("save");
          }}
        >
          <p className="note">
            Target: {seatId ?? "Global FLIGHT orders"}
            {editing !== "new" && ` · replaces #${editing.id}, retaining its history`}
          </p>
          <label htmlFor={formId}>Instruction text</label>
          <textarea
            id={formId}
            ref={editor}
            value={draft}
            rows={4}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            aria-describedby={`${formId}-help${error ? ` ${formId}-error` : ""}`}
            aria-invalid={Boolean(error)}
          />
          {error && (
            <p className="note err" id={`${formId}-error`}>
              {error}
            </p>
          )}
          <p className="note" id={`${formId}-help`}>
            {draft.trim().length} / {INSTRUCTION_TEXT_MAX} characters after edge whitespace is
            removed. Oversized text is refused, never cut.
          </p>
          <div className="instruction-actions">
            <button type="submit" disabled={busy}>
              {busy ? "Saving instruction…" : "Save instruction"}
            </button>
            <button type="button" disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {revoking && (
        <section className="instruction-confirm" aria-label={`Revoke instruction #${revoking.id}`}>
          <p>
            Revoke #{revoking.id} for {seatId ?? "FLIGHT"}? Its text and dates stay in history.
          </p>
          {revoking.kind === "focus" && (
            <Expandable lines={4} of="resulting focus">
              <p className="note">
                Resulting focus:{" "}
                {afterRevoke
                  ? `${instructionValue(afterRevoke)} · ${instructionSource(afterRevoke)} #${afterRevoke.id}`
                  : "Unrestricted · no remaining focus instruction"}
                . This revocation is different from Clear.
              </p>
            </Expandable>
          )}
          <div className="instruction-actions">
            <button
              className="warn"
              ref={confirm}
              type="button"
              disabled={busy}
              onClick={() => void mutate("revoke")}
            >
              {busy ? "Revoking instruction…" : `Confirm revoke #${revoking.id}`}
            </button>
            <button type="button" disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>
        </section>
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: named scroll region needs keyboard scrolling. */}
      <section className="instruction-list" aria-label="Active instructions" tabIndex={0}>
        {resource.data && active.length === 0 && (
          <p className="note">
            {seatId === null ? "No active orders." : "No active seat instructions."}
          </p>
        )}
        {active.map((entry) => (
          <Entry
            entry={entry}
            key={entry.id}
            onEdit={edit}
            onRevoke={revoke}
            disabled={busy || editing !== null || revoking !== null}
          />
        ))}
      </section>
      {selectedId !== null && selectedRef && (
        <InstructionReadState
          resource={selected}
          reference={selectedRef}
          name={`order #${selectedId}`}
        />
      )}
      {selected.data?.revokedAt === null && (
        <section aria-label="Referenced order">
          <Entry key={selected.data.id} entry={selected.data} anchored />
        </section>
      )}
      <details
        className="instruction-history"
        open={historyOpen}
        onToggle={(e) => setHistoryOpen(e.currentTarget.open)}
      >
        <summary>Revoked history</summary>
        {historyOpen && (
          <>
            {selected.data && selected.data.revokedAt !== null && (
              <section aria-label="Referenced revoked order">
                <Entry key={selected.data.id} entry={selected.data} anchored />
              </section>
            )}
            <History seatId={seatId} before={before} onPage={setBefore} />
          </>
        )}
      </details>
    </div>
  );
}

/** The selected target stays open across lazy tab remounts; its detailed reader exists only while open. */
export function SeatInstructionsDisclosure({
  seatId,
  summary,
  compact = false,
}: {
  seatId: string;
  summary?: string;
  compact?: boolean;
}) {
  const targetKey = `seat:${seatId}`;
  const drafts = useStore(instructionDrafts);
  const open = drafts[targetKey]?.expanded ?? false;
  return (
    <details
      className={compact ? "instruction-seat" : "panel instruction-disclosure"}
      open={open}
      onToggle={(event) => {
        const all = instructionDrafts.get();
        if ((all[targetKey]?.expanded ?? false) === event.currentTarget.open) return;
        instructionDrafts.set({
          ...all,
          [targetKey]: { ...(all[targetKey] ?? EMPTY_DRAFT), expanded: event.currentTarget.open },
        });
      }}
    >
      <summary>{summary ?? `Instructions · ${seatId}`}</summary>
      {open && <InstructionManager key={seatId} seatId={seatId} />}
    </details>
  );
}

export function SeatInstructionIndexPanel() {
  const reference = RESOURCES.instructionIndex;
  const index = useResource<SeatInstructionIndex>(reference);
  return (
    <div className="instruction-index">
      <InstructionReadState reference={reference} resource={index} name="seat instruction index" />
      {index.data?.seats.length === 0 && <p className="note">No seats configured.</p>}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: named scroll region needs keyboard scrolling. */}
      <section className="instruction-list" aria-label="Seat instruction summaries" tabIndex={0}>
        {index.data?.seats.map((seat) => (
          <SeatInstructionsDisclosure
            key={seat.seatId}
            seatId={seat.seatId}
            compact
            summary={`${seat.seatId} · ${seat.active.length} active · Focus: ${seat.effectiveFocus ?? "Unrestricted"}${seat.focusInstructionId !== null ? ` · #${seat.focusInstructionId}` : ""}`}
          />
        ))}
      </section>
    </div>
  );
}
export function GlobalOrdersPanel() {
  return (
    <Panel id="ordersP" title="Standing orders" sub="yours, for FLIGHT">
      <InstructionManager seatId={null} />
    </Panel>
  );
}
