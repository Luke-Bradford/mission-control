import {
  AUDIT_PR_OUTLIER_LINES,
  type AuditChange,
  type AuditPrSize,
  type AuditReportView,
  type AuditView,
  auditNoteText,
  type ConfigView,
  GUARD_RULES,
  MC_AUDIT_NO_REPORT,
} from "@mc/core";
import { useEffect, useState } from "react";
import { RESOURCES, useResource } from "../data.ts";
import { cost, elapsed, percent, plural, prLabel } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Seg } from "../hud/Seg.tsx";
import { agentPath, tracePath } from "../router.ts";
import { ModelPanels } from "./ModelTable.tsx";
import "./audit.css";

const RANGES = ["7d", "30d", "90d", "365d"] as const;
type AuditRange = (typeof RANGES)[number];
const RANGE_OPTIONS = RANGES.map((value) => ({ value, label: value }));

/** `actionable` is supplied by newer Audit responses; old servers omit it. */
type AuditData = Omit<AuditView, "longRunners"> & {
  longRunners: (AuditView["longRunners"][number] & { actionable?: boolean })[];
};

/** A run's start as the operator's local date and time, for naming a run without its internal id. */
const startedLabel = (at: number): string =>
  `started ${new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;

/** A guard rule as the Guard drawer words it; a rule from an older hub, no longer listed, shows as stored. */
const ruleLabel = (rule: string): string =>
  Object.hasOwn(GUARD_RULES, rule) ? GUARD_RULES[rule as keyof typeof GUARD_RULES] : rule;

const changes = (s: AuditPrSize): number => s.additions + s.deletions;
const logPercentOfMax = (value: number, max: number): number =>
  (Math.log1p(value) / Math.log1p(max)) * 100;

/** Operator audit: durable evidence over one shared server-bounded period. */
export function Audit() {
  return (
    <section id="page-audit">
      <div className="toolbar">
        <h1 className="toolbar-heading">Audit</h1>
      </div>
      <ReportBand />
      <AuditDashboard />
    </section>
  );
}

const DECIDERS = [
  { value: "all", label: "All" },
  { value: "flight", label: "FLIGHT" },
  { value: "operator", label: "You" },
] as const;
type Decider = (typeof DECIDERS)[number]["value"];
const whenLabel = (at: number): string =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The AUDIT seat's latest report: a verdict, then the findings ranked, each with who acts. */
function ReportBand() {
  const res = useResource<AuditReportView>(RESOURCES.auditReport);
  const [decider, setDecider] = useState<Decider>("all");
  const report = res.data?.report ?? null;
  if (!report) {
    return res.data || res.error ? (
      <p className="s fg2 audit-report-note">{MC_AUDIT_NO_REPORT}</p>
    ) : null;
  }
  const next = res.data?.nextDueAt;
  const findings = [...report.findings]
    .sort((a, b) => a.rank - b.rank)
    .filter((f) => decider === "all" || f.owner === decider);
  return (
    <Panel title="AUDIT's verdict" className="audit-report">
      <div className="pb">
        <p className="audit-verdict">{report.verdict}</p>
        <p className="s fg2 audit-report-note">
          {auditNoteText(
            whenLabel(report.at),
            next == null ? "the next timer tick" : whenLabel(next),
          )}
        </p>
        <Seg label="Decider" options={DECIDERS} value={decider} onChange={setDecider} />
        <ol className="audit-findings">
          {findings.map((f) => (
            <li key={f.rank}>
              <details>
                <summary>
                  <b>{f.problem}</b>{" "}
                  <span className="chip">{f.owner === "operator" ? "You" : "FLIGHT"}</span>
                </summary>
                <p>
                  <b>Evidence</b> {f.evidence}
                </p>
                <p>
                  <b>Likely cause</b> {f.cause}
                </p>
                {f.links.map((l) => (
                  <a key={l.href} href={l.href}>
                    {l.label}
                  </a>
                ))}
              </details>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}

/** Operator quality trends over one range. */
function AuditDashboard() {
  const [range, setRange] = useState<AuditRange>("30d");
  const res = useResource<AuditData>(RESOURCES.audit(range));
  const configRes = useResource<ConfigView>(RESOURCES.config);
  const [last, setLast] = useState<{ range: AuditRange; data: AuditData }>();
  useEffect(() => {
    if (res.data) setLast({ range, data: res.data });
  }, [range, res.data]);
  const audit = res.data ?? last?.data;
  const loading = res.loading && audit === undefined;
  const staleRange = res.data === undefined && last?.range !== undefined && last.range !== range;
  return (
    <div className={res.data === undefined && audit ? "refetching" : undefined}>
      <div className="toolbar">
        <Seg label="Range" options={RANGE_OPTIONS} value={range} onChange={setRange} />
        <span className="note">
          One range applies to every finding, distribution and comparison.
        </span>
      </div>
      {loading && <p className="s">Loading audit…</p>}
      {res.error && !res.data && (
        <p className="s crit-t">Could not load audit: {res.error.message}</p>
      )}
      {staleRange && (
        <p className="s warn-t">
          Showing {last.range} data while {range} is unavailable.
        </p>
      )}
      {audit && (
        <div className="audit-grid">
          <ModelPanels range={range} />
          <Improvements audit={audit} config={configRes.data} configError={configRes.error} />
          <PrSizes sizes={audit.prSizes} />
          <Changes changes={audit.changes} />
          <Checks audit={audit} />
          <Proposals />
        </div>
      )}
    </div>
  );
}

function RunLink({
  row,
  children,
}: {
  row: { runId?: string | null; agentId?: string | null };
  children: string;
}) {
  if (!row.agentId) return <span>{children}</span>;
  return (
    <a href={row.runId ? tracePath(row.agentId, row.runId) : agentPath(row.agentId)}>{children}</a>
  );
}
function Empty({ collected = true }: { collected?: boolean }) {
  return <p className="s fg2">{collected ? "No findings in this range." : "Not collected yet."}</p>;
}

function Improvements({
  audit,
  config,
  configError,
}: {
  audit: AuditData;
  config: ConfigView | undefined;
  configError: Error | null;
}) {
  if (!config) {
    return (
      <Panel title="Improvements to consider" className="audit-panel">
        <div className="pb audit-list">
          <p className="s fg2">
            {configError
              ? `Could not load crew classification: ${configError.message}`
              : "Loading crew classification…"}
          </p>
        </div>
      </Panel>
    );
  }
  const excludedAgents = new Set([
    ...config.loops.map((loop) => loop.id),
    ...(config.crew?.sessions.flatMap((session) =>
      session.seats.filter((seat) => seat.loop === "watch").map((seat) => seat.id),
    ) ?? []),
  ]);
  const actionable = <T extends { agentId: string | null }>(rows: T[]) =>
    rows.filter((row) => row.agentId !== null && !excludedAgents.has(row.agentId));
  const findings = [
    ...actionable(audit.longRunners.filter((row) => row.actionable !== false)).map((x) => ({
      label: `Long runner · ${elapsed(x.durationMs)}`,
      started: startedLabel(x.startedAt),
      row: x,
    })),
    ...actionable(audit.deathLoops).map((x) => ({
      label: `Death loop · ${x.parks ?? 0} parks`,
      started: null,
      row: x,
    })),
    ...actionable(audit.reworkRounds).map((x) => ({
      label: `Rework · ${plural(x.rounds ?? 0, "round")}`,
      started: null,
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
          >{`${x.label} · ${x.row.agentId}${x.started ? ` · ${x.started}` : ""}`}</RunLink>
        ))}
        {actionable(audit.refusals).map((x) => (
          <RunLink key={`${x.agentId}:${x.runId}:${x.rule}`} row={x}>
            {`Guard refusal · ${ruleLabel(x.rule)} · ${x.count} · ${x.agentId}`}
          </RunLink>
        ))}
        {actionable(audit.spendOutliers).map((x) => (
          <RunLink
            key={x.runId}
            row={x}
          >{`Spend outlier · ${x.ticket ?? "no ticket"} · ${cost(x.costUsd)} · ${x.agentId}`}</RunLink>
        ))}
        {findings.length +
          actionable(audit.refusals).length +
          actionable(audit.spendOutliers).length ===
          0 && <Empty />}
      </div>
    </Panel>
  );
}

function PrSizes({ sizes }: { sizes: AuditData["prSizes"] }) {
  const max = Math.max(1, ...sizes.prs.map(changes));
  const showRepos = new Set(sizes.prs.map((pr) => pr.repoId)).size > 1;
  return (
    <Panel
      title="PR size"
      sub={`Log scale · ${AUDIT_PR_OUTLIER_LINES.toLocaleString()}+ changed lines are outliers.`}
      className="audit-panel"
    >
      <div className="pb audit-list">
        {sizes.prs.length === 0 ? (
          <Empty />
        ) : (
          sizes.prs.map((s) => (
            <div className="audit-size" key={`${s.repoId}:${s.number}`}>
              <a href={`/board/${encodeURIComponent(s.repoId)}`}>
                {showRepos ? `${s.repoId} · ` : ""}
                {prLabel(s.number)}
              </a>
              <span className="audit-bar-track">
                <span
                  className="audit-bar"
                  style={{ width: `${logPercentOfMax(changes(s), max)}%` }}
                />
              </span>
              <span>
                {plural(changes(s), "line")}
                {changes(s) >= AUDIT_PR_OUTLIER_LINES ? " · outlier" : ""}
              </span>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

function Changes({ changes: rows }: { changes: AuditChange[] }) {
  return (
    <Panel title="Prompt & model changes" className="audit-panel">
      <div className="pb audit-list">
        {rows.length === 0 ? (
          <Empty />
        ) : (
          rows.map((x) => (
            <div className="audit-change" key={`${x.agentId}:${x.at}:${x.kind}`}>
              <b>{new Date(x.at).toLocaleDateString("en-GB")}</b> ·{" "}
              {x.kind === "prompt" ? "Prompt" : "Model"} change · {x.from ?? "none"} → {x.to}
              <span>
                {" effect · merged "}
                {x.before.merged} → {x.after.merged} · review fail{" "}
                {percent(x.before.reviewFailRate == null ? null : x.before.reviewFailRate * 100)} →{" "}
                {percent(x.after.reviewFailRate == null ? null : x.after.reviewFailRate * 100)} ·
                median cost {cost(x.before.medianCostPerMergedTicket)} →{" "}
                {cost(x.after.medianCostPerMergedTicket)} · rework {x.before.reworkRounds} →{" "}
                {x.after.reworkRounds}
              </span>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

function Checks({ audit }: { audit: AuditData }) {
  const unanswered = (audit.questions?.asked ?? 0) - (audit.questions?.answered ?? 0);
  return (
    <Panel title="Things to check" className="audit-panel">
      <div className="pb audit-list">
        <span>Unanswered questions · {unanswered}</span>
        {audit.chatter.map((x) => (
          <span key={`${x.from}:${x.to}:${x.ticket}`}>
            Chatter · {x.from} ↔ {x.to} · {x.ticket} · {plural(x.rounds, "round")}
          </span>
        ))}
        {audit.refusalsByRule.map((x) => (
          <span key={x.rule}>
            Guard refusal spike · {ruleLabel(x.rule)} · {x.count}
          </span>
        ))}
        {audit.refusalSpikes.map((x) => (
          <RunLink
            key={`${x.agentId}:${x.day}`}
            row={x}
          >{`Guard refusal spike · ${x.count}`}</RunLink>
        ))}
        {audit.flakes.map((x) => (
          <span key={x.key}>{`Flake · ${x.key} · ${x.count}`}</span>
        ))}
      </div>
    </Panel>
  );
}

function Proposals() {
  return (
    <Panel title="SURGEON proposals" className="audit-panel">
      <div className="pb audit-list">
        <Empty collected={false} />
      </div>
    </Panel>
  );
}
