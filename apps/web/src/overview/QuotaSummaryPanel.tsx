import { type ConfigView, type HealthRow, type LimitRow, usageCollector } from "@mc/core";
import { useNow, useTz } from "../clock.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { percent } from "../fmt.ts";
import { GithubRateRow } from "../hud/GithubRateRow.tsx";
import { Panel } from "../hud/Panel.tsx";
import { quotaWindows, resetWhen } from "../quota.ts";

/** The same cached allowance readings as the complete table; never a second poll. */
export function QuotaSummaryPanel() {
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
        {accounts.flatMap((account) =>
          (config?.accounts.find((a) => a.id === account)?.vendor
            ? quotaWindows(config.accounts.find((a) => a.id === account)!.vendor)
            : [
                ...new Set(
                  source.data
                    ?.filter((row) => row.accountId === account)
                    .map((row) => row.window) ?? [],
                ),
              ]
          ).map((window) => {
            const row = source.data?.find((r) => r.accountId === account && r.window === window);
            return (
              <div className="quota-summary-row" key={`${account}:${window}`}>
                <span>
                  {account} · {window}
                </span>
                <b className="num">
                  {row ? `${percent(Math.max(0, 100 - row.used))} left` : "— remaining"}
                </b>
                <ResetSummary
                  row={row ?? null}
                  failed={!!health.find((h) => h.collector === usageCollector(account))?.error}
                />
              </div>
            );
          }),
        )}
        <GithubRateRow />
        <button
          type="button"
          className="quota-details"
          onClick={() => {
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
    </span>
  );
}
