import { type ConfigView, type HealthRow, type LimitRow, usageCollector } from "@mc/core";
import { useRef } from "react";
import { useNow, useTz } from "../clock.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { percent } from "../fmt.ts";
import { GithubRateRow } from "../hud/GithubRateRow.tsx";
import { Panel } from "../hud/Panel.tsx";
import { quotaWindows, resetWhen } from "../quota.ts";
import { OverviewOverflowNote } from "./OverviewOverflowNote.tsx";

/** The same cached allowance readings as the complete table; never a second poll. */
export function QuotaSummaryPanel({ onInspect }: { onInspect?: () => void } = {}) {
  const region = useRef<HTMLElement>(null);
  const health = useResource<HealthRow[]>(RESOURCES.health).data ?? [];
  const source = useResource<LimitRow[]>(RESOURCES.limits);
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const accounts = [
    ...new Set([
      ...(config?.accounts.map((a) => a.id) ?? []),
      ...(source.data?.map((r) => r.accountId) ?? []),
    ]),
  ];
  return (
    <Panel id="quotaSummaryP" title="Provider allowance" sub="remaining">
      <div className="quota-summary pb">
        {source.error && (
          <p role="status" className="warn-t">
            {source.data
              ? "Allowance refresh failed; showing last readings."
              : "Allowance could not load."}
            <button className="sm" type="button" onClick={() => hub.refetch(RESOURCES.limits.path)}>
              Refresh allowance
            </button>
          </p>
        )}
        {!source.data && !source.error && <p className="s muted">Loading account allowance…</p>}
        {source.data && accounts.length === 0 && (
          <p className="s muted">No provider accounts configured.</p>
        )}
        <section
          ref={region}
          className="quota-summary-accounts scroll"
          aria-label="Provider account remaining allowance"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: named bounded account list supports native keyboard scrolling.
          tabIndex={0}
        >
          <div>
            {accounts.map((account) => {
              const vendor = config?.accounts.find((entry) => entry.id === account)?.vendor;
              const windows = vendor
                ? quotaWindows(vendor)
                : [
                    ...new Set(
                      source.data
                        ?.filter((row) => row.accountId === account)
                        .map((row) => row.window) ?? [],
                    ),
                  ];
              const readings = windows.flatMap(
                (window) =>
                  source.data?.filter(
                    (row) => row.accountId === account && row.window === window,
                  ) ?? [],
              );
              const tightest = readings.reduce<LimitRow | null>(
                (chosen, row) => (!chosen || row.used > chosen.used ? row : chosen),
                null,
              );
              const missing = windows.filter(
                (window) => !readings.some((row) => row.window === window),
              ).length;
              return (
                <div className="quota-summary-row" key={account}>
                  <span>
                    {account} · {tightest?.window ?? "window unknown"}
                    {missing > 0 && (
                      <small className="muted">
                        {" "}
                        · {missing} window{missing === 1 ? "" : "s"} unknown
                      </small>
                    )}
                  </span>
                  <b className="num">
                    {tightest ? `${percent(Math.max(0, 100 - tightest.used))} left` : "— remaining"}
                  </b>
                  <ResetSummary
                    row={tightest}
                    failed={
                      !!health.find((row) => row.collector === usageCollector(account))?.error
                    }
                  />
                </div>
              );
            })}
          </div>
        </section>
        <OverviewOverflowNote region={region} label="every provider account" />
        <p className="s muted quota-summary-definition">
          Tightest recorded window per account · unknown windows are not spare allowance.
        </p>
        <div className="quota-summary-footer">
          <GithubRateRow />
          <button
            type="button"
            className="quota-details"
            onClick={() => {
              if (onInspect) {
                onInspect();
                return;
              }
              const panel = document.getElementById("quotaP");
              panel?.scrollIntoView({ block: "start" });
              const heading = panel?.querySelector<HTMLElement>("h2");
              if (heading) {
                heading.tabIndex = -1;
                heading.focus();
              }
            }}
          >
            Used, forecasts and freshness →
          </button>
        </div>
      </div>
    </Panel>
  );
}

function ResetSummary({ row, failed }: { row: LimitRow | null; failed: boolean }) {
  const now = useNow(),
    tz = useTz();
  return (
    <span className="muted">
      {row && tz ? `resets ${resetWhen(row, now, tz)}` : "Reset unknown"}
      {row && (row.stale || failed || now - row.sampledAt > 60 * 60_000) ? " · stale" : ""}
      {row && row.used >= 100 ? (
        <strong className="crit-t"> · at limit</strong>
      ) : row?.fullAt !== null && row && row.fullAt < row.resetAt ? (
        <strong className="warn-t"> · forecast full before reset</strong>
      ) : null}
    </span>
  );
}
