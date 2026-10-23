import {
  type BoardItem,
  type ChangedFiles,
  type CrewRow,
  DIFF_MAX_CHARS,
  type FileDiff,
  READONLY_FILES_NOTE,
  type RunView,
  SUBAGENT_PILL,
  type TicketView,
} from "@mc/core";
import { useState } from "react";
import { errorNote } from "../api.ts";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { LOOP_PHASE_LABEL } from "../crew.ts";
import { RESOURCES, type Resource, RUNS_LIMIT, useResource, useResources } from "../data.ts";
import { dur, kTokens } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import { parseTicket, TicketRef } from "../hud/RepoRef.tsx";
import { Seg } from "../hud/Seg.tsx";
import { BuildChips } from "../shell/buildStatus.tsx";
import { ticketPlan } from "./ticketPlan.ts";

const DASH = "—";

type Tab = "plan" | "queue" | "subs" | "files";

/** The ticket's `## Plan` section: nothing records the agent's own task list, so this is the plan it builds from. */
function Plan({ row }: { row: CrewRow }) {
  const ticket = row.ticket ? parseTicket(row.ticket) : null;
  const res = useResource<TicketView>(
    ticket ? RESOURCES.ticket(ticket.repoId, ticket.number) : null,
  );
  if (!row.ticket || !ticket) return <p className="s muted">No ticket on this run.</p>;
  if (!res.data) {
    return res.error ? (
      <p className="s crit-t">Could not load the ticket: {res.error.message}</p>
    ) : (
      <p className="s muted">Loading…</p>
    );
  }
  const plan = ticketPlan(res.data.body);
  if (plan === null) return <p className="s muted">{row.ticket} has no ## Plan yet.</p>;
  return (
    <>
      <div className="tbody">
        <Markdown text={plan} />
      </div>
      <p className="note xs">From the ## Plan section of {row.ticket}.</p>
      {res.data.bodyTruncated && (
        <p className="s">
          <ExternalLink url={res.data.url}>Continue on GitHub ↗</ExternalLink>
        </p>
      )}
    </>
  );
}

/** A writer seat's queue: the ticket it holds, then the tickets it takes next, in order. */
function Queue({ row }: { row: CrewRow }) {
  const runs = useResource<RunView[]>(
    row.kind === "crew" && row.mode === "writer" ? RESOURCES.runs(row.id) : null,
  );
  const done = (runs.data ?? [])
    .filter(
      (r): r is RunView & { ticket: string } =>
        r.ticket !== null && r.status === "ok" && r.endedAt !== null,
    )
    .filter((r, i, all) => all.findIndex((other) => other.ticket === r.ticket) === i);
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
        <p className="s muted">
          Empty: the engine queues Ready cards in this seat's area, in merge repos only.
        </p>
      ) : (
        queued.map((q) => {
          const item = boards[repoIds.indexOf(q.repoId)]?.data?.find(
            (b) => b.issueNumber === q.number,
          );
          return (
            <div className="qi" key={q.ref}>
              <span className="num muted">{q.pos}</span>
              <span className="min0">
                <TicketRef ticket={q.ref} bare /> {item?.title}
              </span>
              <span className="xs muted">{item?.priority}</span>
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
      {done.map((r) => (
        <div className="qi" key={r.ticket}>
          <span className="ok-t">✓</span>
          <span className="min0">
            <TicketRef ticket={r.ticket} bare />
            {r.ticketTitle && <> {r.ticketTitle}</>}
          </span>
        </div>
      ))}
      {!runs.data ? (
        <p className="s muted">
          {runs.error ? `Could not load the runs: ${runs.error.message}` : "Loading…"}
        </p>
      ) : (
        done.length === 0 && <p className="s muted">None yet.</p>
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
  const [open, setOpen] = useState<string | null>(null);
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
          <span className={f.state === "committed" ? "num xs fg2" : "num xs muted"}>{f.state}</span>
        </button>
      ))}
      {note !== null && <p className="note xs">{note}</p>}
      {shown !== null && <Diff agentId={agentId} path={shown} onClose={() => setOpen(null)} />}
    </>
  );
}

/** The side panel's tabs (catalogue 2.4.6); a file opens its diff below the Files list. */
export function SideTabs({ row }: { row: CrewRow }) {
  const [tab, setTab] = useState<Tab>("plan");
  const files = useResource<ChangedFiles>(RESOURCES.files(row.id));
  const nFiles = files.data?.note === READONLY_FILES_NOTE ? undefined : files.data?.files.length;
  const options = [
    { value: "plan", label: "Plan" },
    { value: "queue", label: "Queue" },
    { value: "subs", label: `Subagents ${row.digest?.subagents.length ?? 0}` },
    { value: "files", label: nFiles === undefined ? "Files" : `Files ${nFiles}` },
  ] as const;
  return (
    <section className="panel" id="sideP" aria-label="Plan, queue, subagents and files">
      <div className="ph">
        <Seg label="Agent details" options={options} value={tab} onChange={setTab} />
        <BuildChips panel="sideP" />
      </div>
      <div className="pb scroll" id="sideBody">
        {tab === "plan" && <Plan row={row} />}
        {tab === "queue" && <Queue row={row} />}
        {tab === "subs" && <Subagents row={row} />}
        {tab === "files" && <Files agentId={row.id} files={files} />}
      </div>
    </section>
  );
}
