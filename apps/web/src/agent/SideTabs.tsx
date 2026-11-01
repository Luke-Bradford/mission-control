import {
  type AgentStream,
  type AttentionItem,
  type BoardItem,
  type ChangedFiles,
  type CrewRow,
  DIFF_MAX_CHARS,
  type FileDiff,
  READONLY_FILES_NOTE,
  type RunView,
  SUBAGENT_PILL,
} from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { apiPost, errorNote } from "../api.ts";
import { LOOP_PHASE_LABEL } from "../crew.ts";
import { hub, RESOURCES, type Resource, RUNS_LIMIT, useResource, useResources } from "../data.ts";
import { dur, kTokens, shortSha } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import { parseTicket, TicketRef } from "../hud/RepoRef.tsx";
import { Seg } from "../hud/Seg.tsx";
import { useSearch } from "../router.ts";
import { BuildChips } from "../shell/buildStatus.tsx";

import { openItem } from "../shell/overlays.ts";
import { toast } from "../shell/Toast.tsx";
import { PromptTab } from "./PromptTab.tsx";

const DASH = "—";

type Tab = "plan" | "queue" | "subs" | "files" | "prompt";

/** The run's own checklist, replayed from its stream. */
function Plan({
  stream,
  tasks,
  hasRun,
}: {
  stream: Resource<AgentStream>;
  tasks: NonNullable<AgentStream["tasks"]>;
  hasRun: boolean;
}) {
  if (hasRun && !stream.data) {
    return stream.error ? (
      <p className="s crit-t">Could not load the task list: {stream.error.message}</p>
    ) : (
      <p className="s muted">Loading…</p>
    );
  }
  return (
    <>
      {hasRun && stream.error && (
        <>
          <p className="s crit-t">Could not refresh the task list: {stream.error.message}</p>
          <p className="note xs">Last known task list.</p>
        </>
      )}
      {tasks.length === 0 && <p className="s muted">No task list yet.</p>}
      {tasks.map((task) => (
        <div className="check" key={task.id}>
          <span
            className={
              task.status === "done"
                ? "ck-pass"
                : task.status === "in_progress"
                  ? "ck-run"
                  : "ck-wait"
            }
          >
            {task.status === "done"
              ? "✓ done"
              : task.status === "in_progress"
                ? "◌ doing"
                : "· to do"}
          </span>
          <span className={task.status === "done" ? "fg2" : undefined}>{task.text}</span>
        </div>
      ))}
      {tasks.length > 0 && (
        <p className="note xs">
          The agent's own task list: Claude's task tools or Codex plan updates, replayed from its
          stream.
        </p>
      )}
    </>
  );
}

/** A writer seat's queue: the ticket it holds, then the tickets it takes next, in order. */
function Queue({ row }: { row: CrewRow }) {
  const focusRef = RESOURCES.focus(row.id);
  const focus = useResource<{ focus: string | null }>(
    row.kind === "crew" && row.mode === "writer" ? focusRef : null,
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ focus: string | null } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const cancel = () => {
    setEditing(false);
  };
  useEffect(() => {
    if (editing) input.current?.focus();
    else changeButton.current?.focus();
  }, [editing]);
  useEffect(() => {
    setSaved(focus.data ?? null);
  }, [focus.data]);
  const change = () => {
    setDraft((saved ?? focus.data)?.focus ?? "");
    setEditing(true);
    setFailure(null);
    toast(
      'Focus is what FLIGHT assigns from: a lane, labels or a ticket list. Change it here, or tell FLIGHT, e.g. "GUIDO-2: catalog bugs only this week".',
    );
  };
  const propose = async (move: string, above: string) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await apiPost<{ item: AttentionItem }>(
        `/api/seats/${encodeURIComponent(row.id)}/queue/reorder`,
        { move, above },
      );
      hub.refetch(RESOURCES.attention.path);
      openItem(result.item.key, result.item);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const runs = useResource<RunView[]>(RESOURCES.runs(row.id));
  // Tickets whose run finished its work, once each (a ticket can take several runs). A run the
  // operator or FLIGHT stopped also ends "ok", as `endedBy: "operator"`: that is not finished.
  const done = [
    ...new Map(
      (runs.data ?? [])
        .filter(
          (r) =>
            r.status === "ok" &&
            r.endedBy !== "operator" &&
            r.endedAt !== null &&
            r.ticket !== null,
        )
        .map((r) => [r.ticket, r]),
    ).values(),
  ];
  const queue = row.queue ?? [];
  const queued = queue.flatMap((q) => {
    const t = parseTicket(q.ref);
    return t ? [{ ...q, ...t }] : [];
  });
  const repoIds = [...new Set(queued.map((q) => q.repoId))];
  const boards = useResources<BoardItem[]>(repoIds.map((id) => RESOURCES.boards(id)));
  if (row.kind !== "crew" || row.mode !== "writer") {
    return <p className="s muted">Only a writer seat has a queue.</p>;
  }
  const holding = row.run !== null && row.run.endedAt === null && row.ticket !== null;
  return (
    <>
      <div className="row s queue-focus">
        <span className="muted">Focus</span>
        {editing ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              setBusy(true);
              setFailure(null);
              try {
                const result = await apiPost<{ focus: string | null }>(focusRef.path, {
                  focus: draft.trim() || null,
                });
                setSaved(result);
                setEditing(false);
                hub.refetch(focusRef.path);
                hub.refetchTopic("agents");
              } catch (e) {
                setFailure(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <input
              aria-label="Focus"
              ref={input}
              onKeyDown={(e) => {
                if (e.key === "Escape" && !busy) {
                  e.preventDefault();
                  e.stopPropagation();
                  cancel();
                }
              }}
              value={draft}
              maxLength={500}
              onChange={(e) => setDraft(e.target.value)}
            />
            <span className="note xs">
              Use lane:name, label:name or repo#issue selectors. Leave empty to clear.
            </span>
            <button type="submit" className="sm" disabled={busy}>
              Save
            </button>
            <button type="button" className="sm ghost" disabled={busy} onClick={cancel}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            <span className="min0">
              {(saved ?? focus.data)?.focus ??
                (focus.data || saved ? "not set · FLIGHT will ask you" : "Loading…")}
            </span>
            <button
              type="button"
              className="sm ghost"
              disabled={busy || !focus.data}
              ref={changeButton}
              onClick={change}
            >
              Change
            </button>
          </>
        )}
      </div>
      {focus.error && (
        <p className="note err" role="alert">
          Could not load Focus: {focus.error.message}
        </p>
      )}
      {failure && (
        <p className="note err" role="alert">
          {failure}
        </p>
      )}
      {busy && (
        <p role="status" className="note">
          Saving…
        </p>
      )}
      <div className="qsec">Now</div>
      {holding && row.ticket ? (
        <div className="qi">
          <span style={{ color: "var(--accent)" }}>▸</span>
          <span className="min0">
            <TicketRef ticket={row.ticket} bare /> {row.ticketTitle}
          </span>
          {row.loop && <span className="xs muted">{LOOP_PHASE_LABEL[row.loop.phase]}</span>}
        </div>
      ) : (
        <p className="s muted">Nothing assigned.</p>
      )}
      <div className="qsec">Next · from Ready, by priority</div>
      {queued.length === 0 ? (
        <p className="s muted">Empty: FLIGHT fills this from the focus.</p>
      ) : (
        queued.map((q, index) => {
          const item = boards[repoIds.indexOf(q.repoId)]?.data?.find(
            (b) => b.issueNumber === q.number,
          );
          const above = queued[index - 1];
          const previous =
            above &&
            boards[repoIds.indexOf(above.repoId)]?.data?.find(
              (b) => b.issueNumber === above.number,
            );
          const eligible =
            above &&
            above.repoId === q.repoId &&
            item?.prioritySource === "field" &&
            previous?.prioritySource === "field" &&
            /^P[0-9]+$/.test(item.priority ?? "") &&
            /^P[0-9]+$/.test(previous.priority ?? "") &&
            Number(item.priority?.slice(1)) > Number(previous.priority?.slice(1));
          return (
            <div className="qi" key={q.ref}>
              <span className="num muted">{q.pos}</span>
              <span className="min0">
                <TicketRef ticket={q.ref} bare /> {item?.title}
              </span>
              <span>
                <span className="xs muted">{item?.priority}</span>
                {eligible && (
                  <button
                    type="button"
                    className="sm ghost"
                    title="Ask FLIGHT to move this up"
                    disabled={busy}
                    onClick={() => void propose(q.ref, above.ref)}
                  >
                    ↑
                  </button>
                )}
              </span>
            </div>
          );
        })
      )}
      <p className="note xs">
        Each ticket starts as a fresh run on its own branch, with the ticket, the repo's docs and
        this lane's notes. Earlier tickets' conversations aren't carried over.
      </p>
      <div className="qsec">
        Done
        {runs.data?.length === RUNS_LIMIT && <span className="muted"> · latest {RUNS_LIMIT}</span>}
      </div>
      {runs.error && !runs.data ? (
        <p className="s crit-t">Could not load finished tickets: {runs.error.message}</p>
      ) : !runs.data ? (
        <p className="s muted">Loading…</p>
      ) : done.length === 0 ? (
        <p className="s muted">None yet.</p>
      ) : (
        done.map((r) => (
          <div className="qi" key={r.id}>
            <span className="ok-t">✓</span>
            <span className="min0">
              <TicketRef ticket={r.ticket as string} bare /> {r.ticketTitle}
            </span>
          </div>
        ))
      )}
    </>
  );
}

function Subagents({ row }: { row: CrewRow }) {
  const subs = row.digest?.subagents ?? [];
  if (subs.length === 0) return <p className="s muted">No subagents spawned this run.</p>;
  return (
    <>
      {subs.map((x) => {
        const pill = SUBAGENT_PILL[x.status];
        return (
          <div className="subrow" key={x.taskId}>
            <span className="min0">
              <b>{x.type}</b> <span className="fg2">{x.description}</span>
            </span>
            <Pill tone={pill.tone}>{pill.label}</Pill>
            <span className="xs muted num" style={{ gridColumn: "1 / -1" }}>
              {x.tokens === null ? DASH : kTokens(x.tokens)} tokens ·{" "}
              {x.toolUses === null ? DASH : x.toolUses} tool calls ·{" "}
              {x.durationMs === null ? DASH : dur(x.durationMs)}
            </span>
          </div>
        );
      })}
      <p className="note xs">Subagents this agent spawned. Their tokens count toward its totals.</p>
    </>
  );
}

/** `200000` as `200 000`. */
const spaced = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** A diff line's class: hunk header, added, removed; none for file headers and context. */
function diffLines(text: string): { cls: string | undefined; line: string }[] {
  let header = false; // between `diff --git` and the first `@@`: `---`/`+++` name files
  return text.split("\n").map((line) => {
    if (line.startsWith("diff --git ")) header = true;
    else if (line.startsWith("@@")) header = false;
    const cls = line.startsWith("@@")
      ? "h"
      : header
        ? undefined
        : line.startsWith("+")
          ? "a"
          : line.startsWith("-")
            ? "d"
            : undefined;
    return { cls, line };
  });
}

/** One file's diff below the list: lines as text, coloured by class. */
function Diff({ agentId, path, onClose }: { agentId: string; path: string; onClose: () => void }) {
  const diff = useResource<FileDiff>(RESOURCES.fileDiff(agentId, path));
  return (
    <div className="fdiff">
      <div className="fdiff-h">
        <span className="mono xs ellip" title={path}>
          {path}
        </span>
        <button type="button" className="sm ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {diff.error && !diff.data ? (
        <p className="s crit-t">{diff.error.message}</p>
      ) : !diff.data ? (
        <p className="s muted">Loading…</p>
      ) : diff.data.binary ? (
        <p className="note xs">Binary file</p>
      ) : (
        <pre className="diff">
          {diffLines(diff.data.text).map(({ cls, line }, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and never reorder
            <span className={cls} key={i}>
              {line}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
      {diff.data?.truncated && (
        <p className="note xs">Cut at {spaced(DIFF_MAX_CHARS)} characters</p>
      )}
    </div>
  );
}

function Files({ agentId, files }: { agentId: string; files: Resource<ChangedFiles> }) {
  const linked = new URLSearchParams(useSearch()).get("path");
  const [open, setOpen] = useState<string | null>(linked);
  useEffect(() => {
    if (linked) setOpen(linked);
  }, [linked]);
  if (files.error && !files.data) {
    const failNote = errorNote(files.error);
    return (
      <>
        <p className="s crit-t">{files.error.message}</p>
        {failNote !== null && <p className="note xs">{failNote}</p>}
      </>
    );
  }
  if (!files.data) return <p className="s muted">Loading…</p>;
  const { files: list, note } = files.data;
  const shown = open !== null && list.some((f) => f.path === open) ? open : null;
  // a read-only seat changes no files: its note alone, not "no changes"
  const unread = note === READONLY_FILES_NOTE;
  return (
    <>
      {list.length === 0 && !unread && <span className="s muted">No file changes yet.</span>}
      {list.map((f) => (
        <button
          type="button"
          className="f"
          key={f.path}
          aria-pressed={f.path === shown}
          onClick={() => setOpen(f.path)}
        >
          <span className="mono xs ellip" title={f.path}>
            {f.path}
          </span>
          <span className="num xs">
            {f.add === null && f.del === null ? (
              DASH
            ) : (
              <>
                <span className="add">+{f.add ?? DASH}</span>{" "}
                <span className="del">−{f.del ?? DASH}</span>
              </>
            )}
          </span>
          <span className={f.state === "committed" ? "num xs fg2" : "num xs muted"}>
            {f.state === "committed" ? (f.commitSha ? shortSha(f.commitSha) : DASH) : "uncommitted"}
          </span>
        </button>
      ))}
      {note !== null && <p className="note xs">{note}</p>}
      {shown !== null && <Diff agentId={agentId} path={shown} onClose={() => setOpen(null)} />}
    </>
  );
}

/** The side panel's tabs (catalogue 2.4.6); a file opens its diff below the Files list. */
export function SideTabs({ row }: { row: CrewRow }) {
  const side = new URLSearchParams(useSearch()).get("side");
  const requested =
    side && ["plan", "queue", "subs", "files", "prompt"].includes(side) ? (side as Tab) : null;
  const hasSubagents = (row.digest?.subagents.length ?? 0) > 0;
  const [tab, setTab] = useState<Tab>(
    requested === "subs" && !hasSubagents ? "plan" : (requested ?? "plan"),
  );
  useEffect(() => {
    if (requested) setTab(requested === "subs" && !hasSubagents ? "plan" : requested);
  }, [requested, hasSubagents]);
  useEffect(() => {
    if (tab === "subs" && !hasSubagents) setTab("plan");
  }, [tab, hasSubagents]);
  const files = useResource<ChangedFiles>(tab === "files" ? RESOURCES.files(row.id) : null);
  const nFiles = files.data?.note === READONLY_FILES_NOTE ? undefined : files.data?.files.length;
  const stream = useResource<AgentStream>(
    row.run && tab === "plan" ? RESOURCES.stream(row.id) : null,
  );
  const tasks = row.run && stream.data?.runId === row.run.id ? (stream.data.tasks ?? []) : [];
  const tasksKnown =
    row.run !== null && stream.data?.runId === row.run.id && !stream.loading && !stream.error;
  const done = tasks.filter((task) => task.status === "done").length;
  const options = [
    { value: "plan", label: tasksKnown ? `Plan ${done}/${tasks.length}` : "Plan" },
    { value: "queue", label: "Queue" },
    ...((row.digest?.subagents.length ?? 0) > 0
      ? [{ value: "subs" as const, label: `Subagents ${row.digest?.subagents.length}` }]
      : []),
    { value: "files", label: nFiles === undefined ? "Files" : `Files ${nFiles}` },
    { value: "prompt", label: "Context" },
  ] as const;
  return (
    <section className="panel" id="sideP" aria-label="Plan, queue, subagents, files and context">
      <div className="ph">
        <Seg label="Agent details" options={options} value={tab} onChange={setTab} />
        <BuildChips panel="sideP" />
      </div>
      <div className="pb scroll" id="sideBody">
        {tab === "plan" && <Plan stream={stream} tasks={tasks} hasRun={row.run !== null} />}
        {tab === "queue" && <Queue key={row.id} row={row} />}
        {tab === "subs" && <Subagents row={row} />}
        {tab === "files" && <Files agentId={row.id} files={files} />}
        {tab === "prompt" && <PromptTab key={row.id} row={row} />}
      </div>
    </section>
  );
}
