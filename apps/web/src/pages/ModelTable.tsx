import {
  MODEL_TABLE_MIN_RUNS,
  type ModelChangeRow,
  type ModelGroupRow,
  type ModelRate,
  type ModelSide,
  type ModelSplit,
  type ModelsView,
} from "@mc/core";
import { useEffect, useState } from "react";
import { type ResourceRef, useResource } from "../data.ts";
import { cost, kTokens, percent, plural } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Seg } from "../hud/Seg.tsx";

/** The model views for one Audit range; shares the audit page's refresh topic. */
const auditModels = (range: string): ResourceRef => ({
  path: `/api/audit/models?range=${encodeURIComponent(range)}`,
  topic: "agents",
});

const SPLIT_OPTIONS: { value: ModelSplit; label: string }[] = [
  { value: "none", label: "None" },
  { value: "type", label: "Ticket type" },
  { value: "size", label: "Size" },
  { value: "plan", label: "Plan" },
];
const SPLIT_HEADING: Record<Exclude<ModelSplit, "none">, string> = {
  type: "Ticket type",
  size: "Size",
  plan: "Plan",
};
/** Rows shown before the table scrolls. */
const VISIBLE_ROWS = 12;

const TOO_FEW = `Too few to compare (under ${MODEL_TABLE_MIN_RUNS} runs)`;

/** A share with its count: `66% (12 of 18)` is too long, so the count sits in the title. */
const rateCell = (r: ModelRate, tooFew: boolean) =>
  tooFew ? (
    <td className="num" title={`${r.count} of ${r.of} runs`}>
      {r.count} of {r.of}
    </td>
  ) : (
    <td className="num" title={`${r.count} of ${r.of} runs`}>
      {percent(r.percent)}
    </td>
  );

const dash = (v: number | null, f: (n: number) => string) => (v === null ? "—" : f(v));

/** Audit's model panels: rework and cost by model and effort, then before and after each change. */
export function ModelPanels({ range }: { range: string }) {
  const res = useResource<ModelsView>(auditModels(range));
  const [last, setLast] = useState<{ range: string; data: ModelsView }>();
  useEffect(() => {
    if (res.data) setLast({ range, data: res.data });
  }, [range, res.data]);
  const data = res.data ?? last?.data;
  const stale = res.data === undefined && last !== undefined && last.range !== range;
  const [split, setSplit] = useState<ModelSplit>("none");
  const status = (
    <>
      {res.loading && data === undefined && <p className="s">Loading model table…</p>}
      {res.error && !res.data && (
        <p className="s crit-t">Could not load model table: {res.error.message}</p>
      )}
      {stale && (
        <p className="s warn-t">
          Showing {last.range} data while {range} is unavailable.
        </p>
      )}
    </>
  );
  const groups = data?.groups[split] ?? [];
  return (
    <>
      <Panel
        title="Rework and cost by model"
        sub="Correlations, not causes. Groups under 20 runs show counts only."
        className="audit-panel audit-wide"
      >
        <div className="pb">
          <div className="toolbar">
            <Seg label="Split" options={SPLIT_OPTIONS} value={split} onChange={setSplit} />
          </div>
          {status}
          {data &&
            (groups.length === 0 ? (
              <p className="s fg2">No reviewed runs in this window.</p>
            ) : (
              <GroupTable groups={groups} split={split} />
            ))}
        </div>
      </Panel>
      <Panel
        title="Before and after each change"
        sub="Each side up to 30 days, bounded by the seat's other changes."
        className="audit-panel audit-wide"
      >
        <div className="pb">
          {status}
          {data &&
            (data.changes.length === 0 ? (
              <p className="s fg2">No model or effort changes in this window.</p>
            ) : (
              <ChangeTable rows={data.changes} />
            ))}
        </div>
      </Panel>
    </>
  );
}

function GroupTable({ groups, split }: { groups: ModelGroupRow[]; split: ModelSplit }) {
  return (
    <div className={`model-scroll${groups.length > VISIBLE_ROWS ? " scrolls" : ""}`}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling table must be reachable by keyboard */}
      <section className="model-scroll-inner" aria-label="Rework and cost by model" tabIndex={0}>
        <table className="ta-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Effort</th>
              {split !== "none" && <th>{SPLIT_HEADING[split]}</th>}
              <th className="num">Runs</th>
              <th className="num">Mean cost</th>
              <th className="num">Round 2+</th>
              <th className="num">Round 3+</th>
              <th className="num">Mean blocking</th>
              <th className="num">Tokens per merged ticket</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={`${g.model}:${g.effort}:${g.split}`}>
                <td title={g.model ?? undefined}>{g.model ?? "—"}</td>
                <td>{g.effort ?? "—"}</td>
                {split !== "none" && <td title={g.split ?? undefined}>{g.split ?? "—"}</td>}
                <td className="num">{g.runs}</td>
                {g.tooFew ? (
                  <td className="num fg2" colSpan={5}>
                    {TOO_FEW}
                  </td>
                ) : (
                  <>
                    <td className="num" title={`${g.pricedRuns} priced`}>
                      {cost(g.meanCost)} <span className="fg2">({g.pricedRuns} priced)</span>
                    </td>
                    {rateCell(g.round2, false)}
                    {rateCell(g.round3, false)}
                    <td className="num">{dash(g.meanBlocking, (n) => n.toFixed(1))}</td>
                    <td className="num">{dash(g.tokensPerMerged, kTokens)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function SideCells({ side }: { side: ModelSide }) {
  return side.tooFew ? (
    <td className="num fg2" colSpan={2} title={TOO_FEW}>
      {plural(side.runs, "run")} · too few
    </td>
  ) : (
    <td className="num" colSpan={2}>
      {percent(side.round3.percent)} · {dash(side.tokensPerMerged, kTokens)} · n={side.runs}
    </td>
  );
}

function ChangeTable({ rows }: { rows: ModelChangeRow[] }) {
  return (
    <div className={`model-scroll${rows.length > VISIBLE_ROWS ? " scrolls" : ""}`}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling table must be reachable by keyboard */}
      <section className="model-scroll-inner" aria-label="Changes" tabIndex={0}>
        <table className="ta-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Seat</th>
              <th>Change</th>
              <th className="num" colSpan={2}>
                Before: round 3+ · tokens per merged ticket
              </th>
              <th className="num" colSpan={2}>
                After: round 3+ · tokens per merged ticket
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.at}:${r.seatId}:${r.change}`}>
                <td>{new Date(r.at).toLocaleDateString("en-GB")}</td>
                <td>{r.seatId ?? "All seats"}</td>
                <td title={r.change}>{r.change}</td>
                <SideCells side={r.before} />
                <SideCells side={r.after} />
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
