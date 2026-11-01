import type { FlightPrFlow, FlightPrFlowRow, FlightPrFlowView } from "@mc/core";
import { memo, useMemo } from "react";
import { useNow } from "../clock.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { elapsed as dur } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { RepoRef, TicketRef } from "../hud/RepoRef.tsx";
import { agentPath, followLink } from "../router.ts";
import { useSessionScope } from "../shell/session.ts";
import { Pending } from "./Pending.tsx";
import "./pr-flow.css";

type Repo = FlightPrFlowView["repos"][number];
const DAY = 24 * 60 * 60_000;
const WEEK = 7 * DAY;
const qaPath = (repoId: string, pr: number) => `/qa?repo=${encodeURIComponent(repoId)}&pr=${pr}`;
const age = (since: number, now: number) => Math.max(0, now - since);
const duration = (value: number | null | undefined) => (value == null ? "—" : dur(value));

/** Each repository's own history sets its thresholds. Unknown history has no implied pass. */
export function stageDelay(row: FlightPrFlowRow, metrics: FlightPrFlow["metrics"], now: number) {
  const times = (
    metrics.find((m) => m.windowMs === WEEK) ?? metrics.find((m) => m.windowMs === DAY)
  )?.stageTimes.find((s) => s.stage === row.stage);
  const elapsed = age(row.stageSince, now);
  if (times?.p90Ms != null && elapsed > times.p90Ms)
    return { tone: "crit", reason: `Past stage p90 (${dur(times.p90Ms)})` } as const;
  if (times?.p50Ms != null && elapsed > times.p50Ms)
    return { tone: "warn", reason: `Past stage p50 (${dur(times.p50Ms)})` } as const;
  return {
    tone: "plain",
    reason: times?.p50Ms == null ? "No stage history" : "Within usual stage time",
  } as const;
}

function FlowRow({ repo, row, now }: { repo: Repo; row: FlightPrFlowRow; now: number }) {
  const delay = stageDelay(row, repo.metrics, now);
  const owner = row.owner === "nobody" ? "Nobody · unowned" : row.owner;
  const seatPath = row.seatId ? agentPath(row.seatId) : null;
  return (
    <tr data-pr={`${repo.repoId}:${row.pr}`}>
      <td>
        <RepoRef repoId={repo.repoId} number={row.pr} kind="pr" to={qaPath(repo.repoId, row.pr)} />
        <div className="pr-flow-title">{row.title}</div>
        <span className="pr-flow-note">Open {dur(age(row.openSince, now))}</span>
      </td>
      <td>
        {seatPath ? (
          <a href={seatPath} onClick={(e) => followLink(e, seatPath)}>
            {owner}
          </a>
        ) : (
          <span className={row.owner === "nobody" ? "err" : undefined}>{owner}</span>
        )}
        {row.ticket && (
          <div className="pr-flow-ticket">
            <TicketRef ticket={row.ticket} bare={row.ticket.startsWith(`${repo.repoId}#`)} />
          </div>
        )}
      </td>
      <td className={`pr-flow-age pr-flow-${delay.tone}`}>
        <strong>{row.stage}</strong>
        <span>{dur(age(row.stageSince, now))}</span>
        <span className="pr-flow-note">{delay.reason}</span>
      </td>
      <td>
        {row.waitsOn.length ? (
          <ul>
            {row.waitsOn.map((wait) => (
              <li key={wait}>{wait}</li>
            ))}
          </ul>
        ) : (
          <span className="pr-flow-note">No recorded wait</span>
        )}
      </td>
      <td>
        {row.blocks.length ? (
          <ul>
            {row.blocks.map((ref) => (
              <li key={ref}>
                {/^PR \d+$/.test(ref) ? (
                  <a href={qaPath(repo.repoId, Number(ref.slice(3)))}>{ref}</a>
                ) : (
                  <TicketRef ticket={ref} bare={ref.startsWith(`${repo.repoId}#`)} />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <span className="pr-flow-note">None recorded</span>
        )}
      </td>
      <td>
        <span>{row.lastAction}</span>
        <span className="pr-flow-note pr-flow-actor">
          {row.lastActor ?? "Actor unknown"}
          {row.lastActionAt != null && ` · ${dur(age(row.lastActionAt, now))} ago`}
        </span>
      </td>
    </tr>
  );
}

/** Shared content for the live panel and its viewport/long-queue fixtures. */
export function PrFlowContent({ repos, now }: { repos: Repo[]; now: number }) {
  const rows = useMemo(
    () =>
      repos
        .flatMap((repo) => repo.rows.map((row) => ({ repo, row })))
        .sort(
          (a, b) =>
            Number(b.row.owner === "nobody") - Number(a.row.owner === "nobody") ||
            a.row.openSince - b.row.openSince ||
            a.repo.repoId.localeCompare(b.repo.repoId) ||
            a.row.pr - b.row.pr,
        ),
    [repos],
  );
  const unowned = rows.filter(({ row }) => row.owner === "nobody").length;
  const oldest = rows.length ? Math.max(...rows.map(({ row }) => age(row.openSince, now))) : null;
  const dayMetrics = repos.map((repo) => repo.metrics.find((m) => m.windowMs === DAY));
  const merged = dayMetrics.every((m) => m !== undefined)
    ? dayMetrics.reduce((sum, m) => sum + (m?.merged ?? 0), 0)
    : null;
  return (
    <>
      <dl className="pr-flow-summary" aria-label="PR flow summary">
        <div>
          <dt>Open</dt>
          <dd>{rows.length}</dd>
        </div>
        <div>
          <dt>Unowned</dt>
          <dd className={unowned ? "err" : undefined}>{unowned}</dd>
        </div>
        <div>
          <dt>Oldest open</dt>
          <dd>{duration(oldest)}</dd>
        </div>
        <div>
          <dt>Merged · 24h</dt>
          <dd>{merged ?? "—"}</dd>
        </div>
        <div className="pr-flow-median">
          <dt>p50 open to merge · 24h</dt>
          <dd>
            {repos.length
              ? repos.map((repo) => (
                  <span key={repo.repoId}>
                    {repos.length > 1 && `${repo.repoId}: `}
                    {duration(repo.metrics.find((m) => m.windowMs === DAY)?.openToMerge.p50Ms)}
                  </span>
                ))
              : "—"}
          </dd>
        </div>
      </dl>
      {rows.length === 0 ? (
        <p className="pb note">No open PRs in this session.</p>
      ) : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded table scroller needs keyboard scrolling.
        <section className="pr-flow-scroll" tabIndex={0} aria-label="Open PR flow">
          <table className="pr-flow-table" aria-label="Open PR flow">
            <colgroup>
              <col />
              <col />
              <col />
              <col />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">PR · oldest unowned first</th>
                <th scope="col">Next owner · ticket</th>
                <th scope="col">Stage · time here</th>
                <th scope="col">Waits on</th>
                <th scope="col">Blocks</th>
                <th scope="col">Last action · actor</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ repo, row }) => (
                <FlowRow key={`${repo.repoId}:${row.pr}`} repo={repo} row={row} now={now} />
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

export const PrFlowPanel = memo(function PrFlowPanel() {
  const res = useResource<FlightPrFlowView>(RESOURCES.prFlow);
  const { repo: scopeRepo } = useSessionScope();
  const now = useNow();
  const repos = useMemo(
    () => res.data?.repos.filter((repo) => scopeRepo === "all" || repo.repoId === scopeRepo) ?? [],
    [res.data, scopeRepo],
  );
  return (
    <Panel
      id="prFlowP"
      title="PR flow"
      sub="who owns the next step, and what holds it"
      actions={
        <button type="button" className="sm" onClick={() => hub.refetch(RESOURCES.prFlow.path)}>
          Refresh
        </button>
      }
    >
      {res.data === undefined ? (
        <Pending what="PR flow" error={res.error} resource={RESOURCES.prFlow} />
      ) : (
        <>
          {res.error && (
            <div className="pr-flow-stale">
              <p className="pb note" role="status">
                Showing the last read.
              </p>
              <Pending what="PR flow" error={res.error} resource={RESOURCES.prFlow} />
            </div>
          )}
          <PrFlowContent repos={repos} now={now} />
        </>
      )}
    </Panel>
  );
});
