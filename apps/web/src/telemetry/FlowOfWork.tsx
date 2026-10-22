import {
  ENGINE_NOT_RUNNING,
  FLIGHT_NOT_RUNNING,
  NO_REVIEWS,
  NO_SIZE,
  type Telemetry,
} from "@mc/core";
import { dayLabel, narrowDay } from "../fmt.ts";
import { HBar } from "../hud/charts/HBar.tsx";
import { VBars } from "../hud/charts/VBars.tsx";
import { Panel } from "../hud/Panel.tsx";
import { DASH, type Scope } from "./common.ts";

function Stat({ value, label, title }: { value: string; label: string; title?: string }) {
  return (
    <div className="stat2">
      <b title={title}>{value}</b>
      <span>{label}</span>
    </div>
  );
}

const tickets = (n: number): string => `${n} ${n === 1 ? "ticket" : "tickets"}`;

/** Flow of work (catalogue 2.6.3): throughput, cycle time, quality and review, You as CAPCOM. */
export function FlowOfWork({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const wait = <p className="pb s muted">{scope.wait}</p>;
  // A size with no tickets has no median, whatever the number says: no bar, and no say in the scale.
  const median = (r: { medianDays: number | null; tickets: number }): number | null =>
    r.tickets === 0 ? null : r.medianDays;
  const longest = Math.max(1, ...(t?.cycleTime.rows.map((r) => median(r) ?? 0) ?? []));
  const ci = t?.quality.ciGreenFirstPushPct ?? null;

  return (
    <div className="tgrid">
      <Panel id="tThru" title="Throughput" sub="tickets merged per day · last 14 days">
        {!t ? (
          wait
        ) : t.throughput.length === 0 ? (
          <p className="pb s muted">No days to show yet.</p>
        ) : (
          <div className="pb">
            <VBars
              label="Tickets merged per day"
              every={2}
              accentLast
              bars={t.throughput.map((d) => ({
                key: d.day,
                label: narrowDay(d.day),
                tip: `${dayLabel(d.day)}: ${d.merged} merged`,
                segments: [{ name: "merged", value: d.merged }],
              }))}
            />
          </div>
        )}
      </Panel>
      {/* Decision (Task 6): work starts at Ready or, when a ticket skipped it, In progress. */}
      <Panel
        id="tCycle"
        title="Cycle time"
        sub="Ready (or In progress) to Done, median days by size"
      >
        {!t ? (
          wait
        ) : (
          <div className="pb">
            {t.cycleTime.rows.map((r) => {
              const days = median(r);
              return (
                <HBar
                  key={r.size}
                  label={r.size === NO_SIZE ? "no size" : r.size}
                  pct={((days ?? 0) / longest) * 100}
                  value={days === null ? DASH : `${days.toFixed(1)} d`}
                  extra={tickets(r.tickets)}
                />
              );
            })}
            <p className="note xs tnote">
              Measured from the board: from the first move into Ready, In progress, In review or
              Ready for QA to when the ticket reached Done. {t.cycleTime.excluded} done tickets went
              straight to Done.
            </p>
          </div>
        )}
      </Panel>
      <Panel id="tQual" title="Quality and review" sub="last 14 days">
        <div className="pb">
          <div className="stats">
            <Stat value={DASH} label="verify passed first try" title={ENGINE_NOT_RUNNING} />
            <Stat value={DASH} label="fix rounds per ticket" title={ENGINE_NOT_RUNNING} />
            <Stat value={DASH} label="median wait for a human review" title={NO_REVIEWS} />
            <Stat value={DASH} label="RETRO findings per PR" title={ENGINE_NOT_RUNNING} />
            <Stat value={DASH} label="PRs sent back by reviewers" title={NO_REVIEWS} />
            <Stat
              value={ci === null ? DASH : `${Math.round(ci)}%`}
              label="CI green on first push"
              title={
                !t
                  ? scope.wait
                  : ci === null
                    ? "No merged PRs with a known first-push CI result in the last 14 days."
                    : `${t.quality.prs} merged PRs with a known first-push CI result`
              }
            />
          </div>
        </div>
      </Panel>
      <Panel id="tCapcom" title="You as CAPCOM" sub="how long work waits on you">
        <div className="pb">
          <div className="stats">
            <Stat value={DASH} label="decisions today" title={FLIGHT_NOT_RUNNING} />
            <Stat value={DASH} label="median response" title={FLIGHT_NOT_RUNNING} />
            <Stat value={DASH} label="slowest 10%" title={FLIGHT_NOT_RUNNING} />
            <Stat value={DASH} label="runs you stopped or interrupted" title={FLIGHT_NOT_RUNNING} />
          </div>
        </div>
      </Panel>
    </div>
  );
}
