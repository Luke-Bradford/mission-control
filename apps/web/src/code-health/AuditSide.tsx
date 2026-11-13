import type { CodeHealthFigure, CodeHealthOverview } from "@mc/core";
import { VBars } from "../hud/charts/VBars.tsx";
import { Panel } from "../hud/Panel.tsx";
import { change, FIGURE_STATE_WORD, measureValue, OUTCOME_WORD, shortDate } from "./auditFormat.ts";
import { label } from "./format.ts";
import { ScrollRegion } from "./ScrollRegion.tsx";

const LEGEND = [
  ["no hub review", "var(--muted)"],
  ["round 1", "var(--accent-soft)"],
  ["round 2", "var(--accent)"],
  ["round 3+", "var(--warn)"],
] as const;

function FigureRow({ figure }: { figure: CodeHealthFigure }) {
  const c = change(figure);
  const note = [figure.coverage, figure.note].filter(Boolean).join(" ");
  return (
    <tr className="ao-frow" title={`${figure.source}. ${note}`}>
      <td className="lab">
        <span className="clamp1">{figure.label}</span>
        {figure.state !== "available" && (
          <span className="sub clamp1">
            {FIGURE_STATE_WORD[figure.state]}
            {figure.numerator !== null && figure.denominator !== null
              ? `: ${figure.numerator} of ${figure.denominator}`
              : ""}
          </span>
        )}
      </td>
      <td className="num mono s m">
        {measureValue(figure.comparison?.value ?? null, figure.unit)}
      </td>
      <td className="num mono s">{measureValue(figure.value, figure.unit)}</td>
      <td>
        <span className={`trend ${c.tone}`}>
          {c.arrow} {c.word}
        </span>
      </td>
    </tr>
  );
}

/** "How we build": merges a day by review round, and the figures behind the verdict. */
export function HowWeBuild({ build, figures }: Pick<CodeHealthOverview, "build" | "figures">) {
  const days = build.mergedPerDay;
  const window = build.merged.window.label;
  return (
    <Panel
      className="ao-build"
      title="How we build"
      sub={`Merged PRs a day, last ${window}`}
      actions={
        <span className="lg">
          {LEGEND.map(([name, color]) => (
            <span key={name}>
              <i style={{ background: color }} aria-hidden="true" />
              {name}
            </span>
          ))}
        </span>
      }
    >
      {days.length ? (
        <div className="ao-plot">
          <VBars
            label="Merged PRs a day by highest review round"
            height={112}
            every={3}
            bars={days.map((d) => ({
              key: d.day,
              label: shortDate(Date.parse(`${d.day}T00:00:00Z`)),
              tip: d.day,
              segments: [
                { name: "no hub review", value: d.noHubReview, color: "var(--muted)" },
                { name: "round 1", value: d.round1, color: "var(--accent-soft)" },
                { name: "round 2", value: d.round2, color: "var(--accent)" },
                { name: "round 3+", value: d.round3Plus, color: "var(--warn)" },
              ],
            }))}
          />
        </div>
      ) : (
        <p className="ao-empty">No merged PRs are recorded in this window.</p>
      )}
      <ScrollRegion className="ao-scroll ao-hscroll" label="Build measures">
        <table className="ao-table">
          <colgroup>
            <col />
            <col className="c-fig" />
            <col className="c-fig" />
            <col className="c-chg" />
          </colgroup>
          <thead>
            <tr>
              <th>Measure</th>
              <th className="num">Before</th>
              <th className="num">Now</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {figures.map((f) => (
              <FigureRow key={f.id} figure={f} />
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </Panel>
  );
}

/** "Where findings land": the files with the most review findings, per merged touch. */
export function WhereFindingsLand({
  landing,
  window,
  onOpenRisk,
}: {
  landing: CodeHealthOverview["landing"];
  window: string;
  onOpenRisk: () => void;
}) {
  const total = landing.files.reduce((sum, f) => sum + f.findings, 0);
  return (
    <Panel
      className="ao-files"
      title="Where findings land"
      sub={
        <>
          <b>{total.toLocaleString("en-GB")}</b> findings in the top {landing.files.length} files,
          last {window}
        </>
      }
      actions={
        <button type="button" className="ao-link" onClick={onOpenRisk}>
          Code risk detail
        </button>
      }
    >
      <ScrollRegion className="ao-scroll" label="Files by findings">
        {landing.files.length ? (
          <table className="ao-table">
            <colgroup>
              <col />
              <col className="c-fig" />
              <col className="c-fig" />
              <col className="c-fig" />
            </colgroup>
            <thead>
              <tr>
                <th>File</th>
                <th className="num">Findings ↓</th>
                <th className="num">Touches</th>
                <th className="num">Per touch</th>
              </tr>
            </thead>
            <tbody>
              {landing.files.map((f) => {
                const per = f.ratio.value;
                return (
                  <tr key={f.path} className="ao-frow">
                    <td className="path" title={f.path}>
                      <bdi>{f.path}</bdi>
                    </td>
                    <td className="num mono s">{f.findings}</td>
                    <td className="num mono s f2">{f.touches}</td>
                    <td
                      className={`num mono s ${per !== null && per >= 1 ? "warn" : "f2"}`}
                      title={f.ratio.coverage}
                    >
                      {per === null ? "—" : per >= 10 ? Math.round(per) : per.toFixed(1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="ao-empty">
            No review findings are recorded on files in this window. That is not a clean bill: it
            may mean no reviews were recorded.
          </p>
        )}
      </ScrollRegion>
    </Panel>
  );
}

const FUNNEL = ["proposed", "accepted", "snoozed", "dismissed", "paid-off", "no-effect"];

/** "What past recommendations achieved": the funnel and each decided proposal's recorded result. */
export function PastResults({ past }: { past: CodeHealthOverview["past"] }) {
  const counts = new Map(past.funnel.map((f) => [f.kind, f.count]));
  const { improved, unchanged, worse, unmeasured } = past.measured;
  const measured = improved + unchanged + worse + unmeasured;
  const accepted = counts.get("accepted") ?? 0;
  return (
    <Panel
      className="ao-past"
      title="What past recommendations achieved"
      actions={
        <span className={accepted === 0 && measured === 0 ? "warn-t" : "m"}>
          {measured === 0 ? "No result measured yet" : `${measured} re-measured`}
        </span>
      }
    >
      <div className="fun">
        {FUNNEL.map((kind) => (
          <div key={kind}>
            <b>{counts.get(kind) ?? 0}</b>
            <span>{label(kind)}</span>
          </div>
        ))}
      </div>
      {measured > 0 && (
        <p className="pasttxt">
          Of the re-measured: {improved} improved, {unchanged} unchanged, {worse} worse,{" "}
          {unmeasured} could not be measured.
        </p>
      )}
      <ScrollRegion className="ao-scroll ao-pscroll" label="Decided proposals">
        {past.items.length ? (
          <table className="ao-table">
            <colgroup>
              <col className="c-date" />
              <col />
              <col className="c-meas2" />
              <col className="c-out" />
            </colgroup>
            <tbody>
              {past.items.map((item) => (
                <tr key={item.id} className="ao-prow">
                  <td className="mono m">{shortDate(item.decidedAt)}</td>
                  <td className="t" title={`${item.title}. ${item.metric}`}>
                    <span className="clamp1">{item.title}</span>
                  </td>
                  <td className="mono num s">
                    {measureValue(item.baseline, "")} →{" "}
                    {measureValue(item.after?.current ?? null, "")}
                  </td>
                  <td>
                    <span className="vd" title={item.after?.note ?? "No re-measure recorded yet."}>
                      <i className={`lamp l-${item.outcome}`} aria-hidden="true" />
                      {OUTCOME_WORD[item.outcome]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="ao-empty">No proposal has been accepted or assessed yet.</p>
        )}
      </ScrollRegion>
    </Panel>
  );
}
