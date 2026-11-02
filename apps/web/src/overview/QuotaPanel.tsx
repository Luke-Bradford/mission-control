import {
  type ConfigView,
  type GithubRateState,
  type HealthRow,
  type LimitRow,
  usageCollector,
} from "@mc/core";
import { useRef } from "react";
import { useNow, useTz } from "../clock.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { percent, rel } from "../fmt.ts";
import { GithubRateRow } from "../hud/GithubRateRow.tsx";
import { Panel } from "../hud/Panel.tsx";
import { quotaWarnings, quotaWindows, resetWhen, timeToFull } from "../quota.ts";
import { AllowanceScrollNote } from "./AllowanceScrollNote.tsx";
import { QuotaMeter } from "./QuotaMeter.tsx";

/** Complete allowance evidence from the same cached resources as the high-level summary. */
export function QuotaPanel() {
  const scrollRegion = useRef<HTMLElement>(null);
  const health = useResource<HealthRow[]>(RESOURCES.health).data ?? [];
  const source = useResource<LimitRow[]>(RESOURCES.limits),
    limits = source.data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const github = useResource<GithubRateState>(RESOURCES.githubRate).data;
  const rows = limits ?? [];
  const accounts = [
    ...new Set([...(config?.accounts.map((a) => a.id) ?? []), ...rows.map((r) => r.accountId)]),
  ];
  const windows = (account: string) => {
    const vendor = config?.accounts.find((a) => a.id === account)?.vendor;
    return vendor
      ? quotaWindows(vendor)
      : [...new Set(rows.filter((r) => r.accountId === account).map((r) => r.window))];
  };
  const shown = rows.filter((r) => windows(r.accountId).includes(r.window));
  const newest = Object.values(github?.queries ?? {}).reduce<NonNullable<
    GithubRateState["queries"][string]
  > | null>((latest, row) => (!latest || row.at >= latest.at ? row : latest), null);
  return (
    <Panel
      id="quotaP"
      title={
        <span
          title={`Claude quota comes from the usage endpoint and from rate-limit events in the loops' transcripts; Codex from its app-server, or its latest session log when that is unavailable. Read every ${config?.poll.usageMinutes ?? "—"} min.`}
        >
          Quota &amp; limits
        </span>
      }
      sub="used, remaining, forecasts and source age"
    >
      <div className="pb">
        {source.error && (
          <p role="status" className="s warn-t">
            {limits
              ? "Allowance refresh failed. Showing the last readings."
              : "Account allowance could not load."}
            <button type="button" className="sm" onClick={() => hub.refetch(RESOURCES.limits.path)}>
              Refresh allowance
            </button>
          </p>
        )}
        {!limits && !source.error && <p className="s muted">Loading account allowance…</p>}
        {limits && accounts.length === 0 && (
          <p className="s muted">No provider accounts configured.</p>
        )}
        <AllowanceScrollNote region={scrollRegion} />
        <section
          className="allowance-scroll scroll"
          ref={scrollRegion}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the named table region supports keyboard scrolling in both dimensions.
          tabIndex={0}
          aria-label="Complete provider allowance"
        >
          <table className="overview-allowance-table">
            <thead>
              <tr>
                <th>Account / window</th>
                <th className="num">Used</th>
                <th className="num">Remaining</th>
                <th>Resets</th>
                <th>Forecast / freshness</th>
              </tr>
            </thead>
            {accounts.map((account) => (
              <tbody className="quotarow" data-windows={windows(account).length} key={account}>
                {windows(account).map((window) => {
                  const row = rows.find((r) => r.accountId === account && r.window === window);
                  const note = health.find((h) => h.collector === usageCollector(account))?.error;
                  return (
                    <tr key={window}>
                      <th scope="row">
                        {account} · {window}
                      </th>
                      <UsedAllowanceCell row={row ?? null} account={account} window={window} />
                      <td className="num">
                        {row ? `${percent(Math.max(0, 100 - row.used))} left` : "—"}
                      </td>
                      <ResetAllowanceCell row={row ?? null} />
                      <ForecastAllowanceCell row={row ?? null} note={note ?? null} />
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </section>
        <details className="allowance-provenance">
          <summary>Allowance sources and collection window</summary>
          <p className="s">
            Claude quota comes from the usage endpoint and from rate-limit events in the loops'
            transcripts; Codex from its app-server, or its latest session log when that is
            unavailable. Read every {config?.poll.usageMinutes ?? "—"} min. These percentages are
            account allowance, not raw tokens remaining.
          </p>
        </details>
        <GithubRateRow />
        <details className="github-budget-details">
          <summary>GitHub API budget details · points</summary>
          {newest ? (
            <dl>
              <dt>Hourly limit</dt>
              <dd className="num">{newest.limit}</dd>
              <dt>Used at last reading</dt>
              <dd className="num">{Math.max(0, newest.limit - newest.remaining)}</dd>
              <dt>Remaining</dt>
              <dd className="num">{newest.remaining}</dd>
              <dt>Latest poll cost</dt>
              <dd className="num">{github?.pollCost ?? "—"} points</dd>
            </dl>
          ) : (
            <p className="s muted">No GitHub rate-limit reading yet.</p>
          )}
        </details>
        <AllowanceWarnings rows={shown} />
      </div>
    </Panel>
  );
}

/** Only time-dependent cells subscribe to the clock; the table and identities remain stable. */
function UsedAllowanceCell({
  row,
  account,
  window,
}: {
  row: LimitRow | null;
  account: string;
  window: "5h" | "7d";
}) {
  const now = useNow(),
    tz = useTz();
  return (
    <td className="num">
      <span
        title={
          row
            ? `${account} ${window}: ${percent(row.used)} used · ${timeToFull(row, now)} · resets ${tz ? resetWhen(row, now, tz) : "—"} · read ${tz ? rel(row.sampledAt, now, tz) : "—"}`
            : `${account} ${window}: No reading yet`
        }
      >
        <QuotaMeter row={row} accountId={account} window={window} now={now} hideDetail />
      </span>
    </td>
  );
}
function ResetAllowanceCell({ row }: { row: LimitRow | null }) {
  const now = useNow(),
    tz = useTz();
  return <td>{row && tz ? resetWhen(row, now, tz) : "Reset unknown"}</td>;
}
function ForecastAllowanceCell({ row, note }: { row: LimitRow | null; note: string | null }) {
  const now = useNow(),
    tz = useTz();
  const stale = !!row && (row.stale || now - row.sampledAt > 60 * 60_000 || !!note);
  return (
    <td>
      {row ? (
        <>
          <span>
            {row.window === "7d" && row.projected !== null
              ? `${percent(row.projected)} projected at reset · `
              : ""}
            {row.used >= 100
              ? "At limit"
              : row.fullAt !== null
                ? `Full in ${timeToFull(row, now)} at this rate`
                : timeToFull(row, now)}
          </span>
          <span className="allowance-source muted">
            {row.source} · {tz ? `read ${rel(row.sampledAt, now, tz)}` : "Read age unknown"}
            {stale ? " · stale" : ""}
            {row.nextTryAt && row.nextTryAt > now
              ? ` · next try in ${Math.ceil((row.nextTryAt - now) / 60_000)}m`
              : ""}
          </span>
        </>
      ) : (
        "No reading yet"
      )}
      {note && (
        <span role="status" className="warn-t">
          {note}
        </span>
      )}
    </td>
  );
}
function AllowanceWarnings({ rows }: { rows: LimitRow[] }) {
  const now = useNow(),
    tz = useTz(),
    warnings = tz ? quotaWarnings(rows, now, tz) : [];
  return warnings.length ? (
    <p className="s quotawarn">
      {warnings.map((w) => (
        <span className={w.crit ? "crit-t block" : "block"} key={w.text}>
          {w.text}
        </span>
      ))}
    </p>
  ) : null;
}
