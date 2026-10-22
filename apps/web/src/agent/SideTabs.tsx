import {
  type ChangedFiles,
  CREW_FILES_NOTE,
  type CrewRow,
  DIFF_MAX_CHARS,
  ENGINE_NOT_RUNNING,
  type FileDiff,
  SUBAGENT_PILL,
} from "@mc/core";
import { useState } from "react";
import { errorNote } from "../api.ts";
import { RESOURCES, type Resource, useResource } from "../data.ts";
import { dur, kTokens } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import { Seg } from "../hud/Seg.tsx";
import { BuildChips } from "../shell/buildStatus.tsx";

const DASH = "—";

/** **Decision (Task 2):** the loops' CLI has no task-list tool, so the Plan tab waits for one. */
export const PLAN_PLACEHOLDER =
  "The loops' CLI has no task-list tool; the Plan tab fills when the agent runtime reports one (phase 2).";

type Tab = "plan" | "queue" | "subs" | "files";

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
  // a crew seat's list is not read yet (phase 2b): its note alone, not "no changes"
  const unread = note === CREW_FILES_NOTE;
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
  const nFiles = files.data?.note === CREW_FILES_NOTE ? undefined : files.data?.files.length;
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
        {tab === "plan" && <p className="s muted">{PLAN_PLACEHOLDER}</p>}
        {tab === "queue" && <p className="s muted">{ENGINE_NOT_RUNNING}</p>}
        {tab === "subs" && <Subagents row={row} />}
        {tab === "files" && <Files agentId={row.id} files={files} />}
      </div>
    </section>
  );
}
