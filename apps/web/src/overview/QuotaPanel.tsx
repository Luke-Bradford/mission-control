import type { ConfigView, LimitRow } from "@mc/core";
import { useNow, useTz } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { percent, rel } from "../fmt.ts";
import { GithubRateRow } from "../hud/GithubRateRow.tsx";
import { Panel } from "../hud/Panel.tsx";
import { quotaWarnings, resetWhen, timeToFull } from "../quota.ts";
import { QuotaMeter } from "./QuotaMeter.tsx";

const DASH = "—";

/** The hover text of one bar: `{account} {window}: {used}% used · {time to full} · resets {when}`. */
function title(row: LimitRow, now: number, tz: string | null): string {
  return [
    `${row.accountId} ${row.window}: ${percent(row.used)} used`,
    timeToFull(row, now),
    `resets ${tz ? resetWhen(row, now, tz) : DASH}`,
    row.stale ? "stale" : null,
  ]
    .filter((p) => p !== null)
    .join(" · ");
}

/** Each account's 5-hour and 7-day windows (catalogue 2.1.5). */
export function QuotaPanel() {
  const limits = useResource<LimitRow[]>(RESOURCES.limits).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const now = useNow();
  const tz = useTz();
  const rows = limits ?? [];
  const accounts = [
    ...new Set([...(config?.accounts.map((a) => a.id) ?? []), ...rows.map((r) => r.accountId)]),
  ];
  const cell = (account: string, window: "5h" | "7d") => {
    const row = rows.find((r) => r.accountId === account && r.window === window);
    return row ? (
      <span title={title(row, now, tz)}>
        <QuotaMeter row={row} now={now} showAge />
      </span>
    ) : (
      <QuotaMeter row={null} accountId={account} window={window} now={now} />
    );
  };
  const warnings = tz ? quotaWarnings(rows, now, tz) : [];

  return (
    <Panel
      id="quotaP"
      title={
        <span
          title={`Claude quota comes from the usage endpoint and from rate-limit events in the loops' transcripts; Codex from its app-server, or its latest session log when that is unavailable. Read every ${config?.poll.usageMinutes ?? DASH} min.`}
        >
          Quota &amp; limits
        </span>
      }
    >
      <div className="pb">
        {accounts.map((a) => {
          const mine = rows.filter((r) => r.accountId === a);
          const read =
            tz && mine.length > 0
              ? `read ${rel(Math.max(...mine.map((r) => r.sampledAt)), now, tz)}`
              : null;
          return (
            <div className="quotarow" key={a}>
              <span className="min0 quota-account" title={read ?? undefined}>
                <span className="ellip" title={a}>
                  {a}
                </span>
              </span>
              {cell(a, "5h")}
              {cell(a, "7d")}
            </div>
          );
        })}
        <GithubRateRow />
        {warnings.length > 0 && (
          <p className="s quotawarn">
            {warnings.map((w) => (
              <span
                key={w.text}
                className={w.crit ? "crit-t ellip block" : "ellip block"}
                title={w.text}
              >
                {w.text}
              </span>
            ))}
          </p>
        )}
      </div>
    </Panel>
  );
}
