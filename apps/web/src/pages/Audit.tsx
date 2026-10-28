import { useEffect, useState } from "react";
import { RESOURCES, useResource } from "../data.ts";
import { prLabel } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Seg } from "../hud/Seg.tsx";

const RANGES = ["7d", "30d", "90d", "365d"] as const;
type AuditRange = (typeof RANGES)[number];
const RANGE_OPTIONS = RANGES.map((value) => ({ value, label: value }));

type Run = {
  runId: string;
  agentId?: string;
  ticket?: string | null;
  durationMs?: number;
  parks?: number;
  rounds?: number;
};
type Size = {
  repoId: string;
  number: number;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  runId?: string;
};
type Change = {
  at: number;
  model?: string | null;
  accountId?: string | null;
  effort?: string | null;
  promptHash?: string | null;
  metrics?: { cycleMs?: number | null; costUsd?: number | null; reworkRounds?: number | null };
};
type Audit = {
  longRunners?: Run[];
  deathLoops?: Run[];
  reworkRounds?: Run[];
  refusalsByRule?: { rule: string; count: number }[];
  costPerMergedTicket?: { ticket: string; costUsd: number | null }[];
  prSizes?: Size[];
  modelPromptTimeline?: Change[];
  questions?: { asked: number; answered: number; answerMs: number | null };
  chatter?: { messages: number; unnecessary?: number };
  flakes?: { name: string; count: number; runId?: string }[];
  proposals?: {
    id: string;
    title: string;
    status: "open" | "ticketed" | "dismissed" | "verified";
    runId?: string;
  }[];
};

const duration = (ms: number | null | undefined): string => {
  if (ms === undefined || ms === null) return "—";
  const h = Math.floor(ms / 3_600_000);
  return h ? `${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m` : `${Math.floor(ms / 60_000)}m`;
};
const cost = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `$${n.toFixed(2)}`;
const changes = (s: Size): number => (s.additions ?? 0) + (s.deletions ?? 0);
const isOutlier = (s: Size, sizes: readonly Size[]): boolean =>
  sizes.length > 1 && changes(s) === Math.max(...sizes.map(changes));

/** Operator audit: durable evidence over one shared server-bounded period. */
export function Audit() {
  const [range, setRange] = useState<AuditRange>("30d");
  const res = useResource<Audit>(RESOURCES.audit(range));
  const [last, setLast] = useState<Audit>();
  useEffect(() => {
    if (res.data) setLast(res.data);
  }, [res.data]);
  const audit = res.data ?? last;
  const loading = res.loading && audit === undefined;
  return (
    <section id="page-audit" className={res.data === undefined && audit ? "refetching" : undefined}>
      <div className="toolbar">
        <h1 className="toolbar-heading">Audit</h1>
        <Seg label="Range" options={RANGE_OPTIONS} value={range} onChange={setRange} />
        <span className="note">
          One range applies to every finding, distribution and comparison.
        </span>
      </div>
      {loading && <p className="s">Loading audit…</p>}
      {res.error && !audit && <p className="s crit-t">Could not load audit: {res.error.message}</p>}
      {audit && (
        <div className="audit-grid">
          <Improvements audit={audit} />
          <PrSizes sizes={audit.prSizes ?? []} />
          <Changes changes={audit.modelPromptTimeline ?? []} />
          <Checks audit={audit} />
          <Proposals proposals={audit.proposals ?? []} />
        </div>
      )}
    </section>
  );
}

function RunLink({
  row,
  children,
}: {
  row: Run | { runId?: string; agentId?: string };
  children: string;
}) {
  if (!row.runId || !row.agentId) return <span>{children}</span>;
  return (
    <a href={`/agent/${encodeURIComponent(row.agentId)}?run=${encodeURIComponent(row.runId)}`}>
      {children}
    </a>
  );
}
function Empty() {
  return <p className="s fg2">No findings in this range.</p>;
}

function Improvements({ audit }: { audit: Audit }) {
  const costs = audit.costPerMergedTicket ?? [];
  const highCost = costs.length > 1 ? Math.max(...costs.map((x) => x.costUsd ?? 0)) : -1;
  const findings = [
    ...(audit.longRunners ?? []).map((x) => ({
      label: `Long runner · ${duration(x.durationMs)}`,
      row: x,
    })),
    ...(audit.deathLoops ?? []).map((x) => ({
      label: `Death loop · ${x.parks ?? 0} parks`,
      row: x,
    })),
    ...(audit.reworkRounds ?? []).map((x) => ({
      label: `Rework · ${x.rounds ?? 0} rounds`,
      row: x,
    })),
  ];
  return (
    <Panel title="Improvements to consider" className="audit-panel">
      <div className="pb audit-list">
        {findings.map((x) => (
          <RunLink
            key={`${x.label}:${x.row.runId}`}
            row={x.row}
          >{`${x.label} · ${x.row.runId}`}</RunLink>
        ))}
        {(audit.refusalsByRule ?? []).map((x) => (
          <span key={x.rule}>
            Guard refusal · {x.rule} · {x.count}
          </span>
        ))}
        {costs
          .filter((x) => x.costUsd === highCost)
          .map((x) => (
            <span key={x.ticket}>
              Spend outlier · {x.ticket} · {cost(x.costUsd)}
            </span>
          ))}
        {findings.length +
          (audit.refusalsByRule?.length ?? 0) +
          costs.filter((x) => x.costUsd === highCost).length ===
          0 && <Empty />}
      </div>
    </Panel>
  );
}

function PrSizes({ sizes }: { sizes: Size[] }) {
  const max = Math.max(1, ...sizes.map(changes));
  return (
    <Panel title="PR size" className="audit-panel">
      <div className="pb audit-list">
        {sizes.length === 0 ? (
          <Empty />
        ) : (
          sizes.map((s) => (
            <div className="audit-size" key={`${s.repoId}:${s.number}`}>
              <a href={`/board/${encodeURIComponent(s.repoId)}`}>{prLabel(s.number)}</a>
              <span className="audit-bar">
                <i style={{ width: `${(changes(s) / max) * 100}%` }} />
              </span>
              <span>
                {changes(s)} lines{isOutlier(s, sizes) ? " · outlier" : ""}
              </span>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

function Changes({ changes: rows }: { changes: Change[] }) {
  return (
    <Panel title="Prompt & model changes" className="audit-panel">
      <div className="pb audit-list">
        {rows.length === 0 ? (
          <Empty />
        ) : (
          rows.map((x, i) => {
            const before = rows[i - 1]?.metrics;
            const changed =
              i > 0 && (x.model !== rows[i - 1]?.model || x.promptHash !== rows[i - 1]?.promptHash);
            return (
              <div className="audit-change" key={`${x.at}:${x.promptHash ?? ""}`}>
                <b>{new Date(x.at).toLocaleDateString("en-GB")}</b> {x.model ?? "default model"} ·{" "}
                {x.effort ?? "default effort"}
                {changed && (
                  <span>
                    {" "}
                    changed · cycle {duration(before?.cycleMs)} → {duration(x.metrics?.cycleMs)} ·
                    cost {cost(before?.costUsd)} → {cost(x.metrics?.costUsd)}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}

function Checks({ audit }: { audit: Audit }) {
  const unanswered = (audit.questions?.asked ?? 0) - (audit.questions?.answered ?? 0);
  return (
    <Panel title="Things to check" className="audit-panel">
      <div className="pb audit-list">
        <span>Unanswered questions · {unanswered}</span>
        {audit.chatter && (
          <span>
            Chatter · {audit.chatter.unnecessary ?? audit.chatter.messages} of{" "}
            {audit.chatter.messages}
          </span>
        )}
        {(audit.refusalsByRule ?? []).map((x) => (
          <span key={x.rule}>
            Guard refusal spike · {x.rule} · {x.count}
          </span>
        ))}
        {(audit.flakes ?? []).map((x) => (
          <span key={x.name}>
            Flake · {x.name} · {x.count}
            {x.runId ? ` · ${x.runId}` : ""}
          </span>
        ))}
      </div>
    </Panel>
  );
}

function Proposals({ proposals }: { proposals: NonNullable<Audit["proposals"]> }) {
  return (
    <Panel title="SURGEON proposals" className="audit-panel">
      <div className="pb audit-list">
        {proposals.length === 0 ? (
          <Empty />
        ) : (
          proposals.map((x) => (
            <div className="audit-proposal" key={x.id}>
              <span>{x.title}</span>
              <span className={`audit-status audit-status-${x.status}`}>{x.status}</span>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
