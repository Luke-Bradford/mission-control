import {
  type ChainNode,
  type ConfigView,
  compareDependencyChains,
  type DependencyChain,
} from "@mc/core";
import { useMemo, useRef, useState } from "react";
import { useTz } from "../clock.ts";
import { hub, RESOURCES, streamStatus, useResource } from "../data.ts";
import { hhmm } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { agentPath, followLink, ticketPath } from "../router.ts";
import { useStore } from "../shell/store.ts";
import {
  CHAIN_COLUMNS,
  chainStats,
  EDGE_WORD,
  flattenChain,
  MAX_SHOWN,
  NO_START,
  SHOWN_WHEN_CAPPED,
  STATE_MARK,
  STATE_WORD,
  waitText,
} from "./chains.ts";
import "./blocked-chains.css";

const enc = encodeURIComponent;
const MINUTE = 60_000;
const READING = "Reading what waits on what…";
const FAILED = "Blocked chains did not load.";
const EMPTY = "Nothing is waiting on other work.";

/** The repo a ref names (`repo#n`, `PR n`, `repo PR n`), falling back to the chain's own. */
function parseRef(ref: string, repoId: string) {
  const pr = /^(?:(\S+) )?PR (\d+)$/.exec(ref);
  if (pr) return { repo: pr[1] ?? repoId, kind: "pr" as const, number: Number(pr[2]) };
  const tk = /^(.*[^#\s])#(\d+)$/.exec(ref);
  if (tk) return { repo: tk[1] ?? repoId, kind: "ticket" as const, number: Number(tk[2]) };
  return null;
}

/** A ref as the app links it: a ticket opens its page, a PR the QA page, an untracked repo is text. */
function ChainRef({
  value,
  repoId,
  tracked,
  className = "bc-ref",
}: {
  value: string;
  repoId: string;
  tracked: ReadonlySet<string> | null;
  className?: string;
}) {
  const parsed = parseRef(value, repoId);
  if (!parsed || (tracked && !tracked.has(parsed.repo)))
    return <span className={className}>{value}</span>;
  const href =
    parsed.kind === "pr"
      ? `/qa?repo=${enc(parsed.repo)}&pr=${parsed.number}`
      : ticketPath(parsed.repo, parsed.number);
  return (
    <a className={className} href={href} onClick={(e) => followLink(e, href)}>
      {value}
    </a>
  );
}

function Wait({ ms }: { ms: number | null }) {
  return ms === null ? <span title={NO_START}>—</span> : waitText(ms);
}

function Owner({ chain }: { chain: DependencyChain }) {
  if (chain.seatId && chain.owner !== "You" && chain.owner !== "—") {
    const href = agentPath(chain.seatId);
    return (
      <a href={href} onClick={(e) => followLink(e, href)}>
        {chain.owner}
      </a>
    );
  }
  return <>{chain.owner}</>;
}

function RootRow({
  chain,
  tracked,
}: {
  chain: DependencyChain;
  tracked: ReadonlySet<string> | null;
}) {
  const unread = /^PR \d+$/.test(chain.root.ref) && chain.state === "unknown";
  return (
    <tr className="bc-row bc-root" data-ref={chain.root.ref}>
      <td className="bc-work">
        <ChainRef value={chain.root.ref} repoId={chain.repoId} tracked={tracked} />
        <span className="bc-title" title={chain.root.title ?? undefined}>
          {unread ? `${chain.root.ref} not read yet` : chain.root.title}
        </span>
      </td>
      <td>
        <span className={`bc-state ${chain.state}`}>
          {STATE_MARK[chain.state] && <span aria-hidden="true">{STATE_MARK[chain.state]}</span>}
          <span>{STATE_WORD[chain.state]}</span>
        </span>
      </td>
      <td className="bc-ell" title={chain.reason}>
        {chain.reason}
      </td>
      <td className="bc-ell">
        <Owner chain={chain} />
      </td>
      <td className="bc-num">
        <Wait ms={chain.longestWaitMs} />
      </td>
      <td className="bc-num">{chain.frees.length}</td>
    </tr>
  );
}

function ChildRow({
  chain,
  node,
  depth,
  parent,
  tracked,
}: {
  chain: DependencyChain;
  node: ChainNode;
  depth: number;
  parent: ChainNode;
  tracked: ReadonlySet<string> | null;
}) {
  const edge = node.edge ?? "depends";
  return (
    <tr className="bc-row" data-ref={node.ref} data-parent={parent.ref}>
      <td className="bc-work" style={{ paddingLeft: `${depth * 16}px` }}>
        <ChainRef value={node.ref} repoId={chain.repoId} tracked={tracked} />
        <span className="bc-title" title={node.title ?? undefined}>
          {node.title}
        </span>
        <span className="bc-edge">
          · {EDGE_WORD[edge]}{" "}
          {edge === "queue" && chain.seatId ? (
            <a
              href={agentPath(chain.seatId)}
              onClick={(e) => followLink(e, agentPath(chain.seatId ?? ""))}
            >
              {chain.seatId.toUpperCase()}
            </a>
          ) : (
            <ChainRef value={parent.ref} repoId={chain.repoId} tracked={tracked} />
          )}
        </span>
        {node.alsoWaitsOn.map((other) => (
          <span className="bc-also" key={other}>
            also waits on <ChainRef value={other} repoId={chain.repoId} tracked={tracked} />
          </span>
        ))}
      </td>
      <td />
      <td />
      <td />
      <td className="bc-num">
        <Wait ms={node.waitedMs} />
      </td>
      <td />
    </tr>
  );
}

function ChainRows({
  chain,
  tracked,
}: {
  chain: DependencyChain;
  tracked: ReadonlySet<string> | null;
}) {
  const [open, setOpen] = useState(false);
  const rows = flattenChain(chain.root);
  const capped = rows.length > MAX_SHOWN && !open;
  return (
    <>
      <RootRow chain={chain} tracked={tracked} />
      {(capped ? rows.slice(0, SHOWN_WHEN_CAPPED) : rows).map((row) => (
        <ChildRow
          key={`${row.parent.ref}>${row.node.ref}`}
          chain={chain}
          node={row.node}
          depth={row.depth}
          parent={row.parent}
          tracked={tracked}
        />
      ))}
      {capped && (
        <tr className="bc-row bc-more">
          <td className="bc-work" style={{ paddingLeft: "16px" }}>
            <button type="button" aria-expanded="false" onClick={() => setOpen(true)}>
              {rows.length - SHOWN_WHEN_CAPPED} more
            </button>
          </td>
        </tr>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  unit,
  title,
}: {
  label: string;
  value: string;
  unit: string;
  title: string;
}) {
  return (
    <div className="bc-stat" title={title}>
      <span className="bc-k">{label}</span>
      <b>{value}</b>
      <span className="bc-u">{unit}</span>
    </div>
  );
}

/** Blocked chains: what is stuck, what holds it and what each merge frees. Display only. */
export function BlockedChains() {
  const read = useResource<DependencyChain[]>(RESOURCES.dependencies);
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const tz = useTz();
  const connection = useStore(streamStatus);
  // When this copy of the list arrived: the mockup's "{n} min old" and "from {hh:mm}".
  const arrived = useRef<{ data: unknown; at: number }>({ data: undefined, at: Date.now() });
  if (read.data !== arrived.current.data) arrived.current = { data: read.data, at: Date.now() };
  const chains = useMemo(() => [...(read.data ?? [])].sort(compareDependencyChains), [read.data]);
  const tracked = useMemo(() => (config ? new Set(config.repos.map((r) => r.id)) : null), [config]);
  const known = read.data !== undefined;
  const failed = !known && read.error !== null;
  const stats = chainStats(chains);
  const dash = !known;
  const retry = () => hub.refetch(RESOURCES.dependencies.path);
  const minutes = Math.max(0, Math.floor((Date.now() - arrived.current.at) / MINUTE));
  const strip =
    known && !connection.connected ? (
      <p className="bc-strip crit" role="alert">
        Not connected to the hub.{" "}
        {tz
          ? `This list is from ${hhmm(arrived.current.at, tz)}.`
          : "This list is from the last read."}
      </p>
    ) : known && read.error ? (
      <p className="bc-strip" role="status">
        Showing the last read, {minutes} min old.
        <button type="button" onClick={retry}>
          Try again
        </button>
      </p>
    ) : null;
  return (
    <Panel
      id="chainsP"
      title="Blocked chains"
      className="bc-panel"
      sub="longest wait first · time since the hub first saw each wait"
      actions={<span className="bc-scope">Scope: all repos</span>}
    >
      <section className="bc-stats" aria-label="Blocked chains summary">
        <Stat
          label="Chains"
          value={dash ? "—" : String(stats.chains)}
          unit="roots"
          title="Chains: distinct roots, a count, now."
        />
        <Stat
          label="Stuck"
          value={dash ? "—" : String(stats.stuck)}
          unit={`of ${dash ? "—" : stats.chains}`}
          title="Stuck: chains in that state, a count, now."
        />
        <Stat
          label="Waiting"
          value={dash ? "—" : String(stats.waiting)}
          unit="tickets and PRs"
          title="Waiting: distinct tickets and PRs under a root, a count, now."
        />
        <Stat
          label="Longest wait"
          value={dash ? "—" : waitText(stats.longestMs)}
          unit="since first seen"
          title="Longest wait: the largest time since a wait was first seen, a duration, now."
        />
      </section>
      {strip}
      <div className="bc-scroll">
        {failed ? (
          <p className="bc-note crit" role="alert">
            {FAILED}{" "}
            <button type="button" onClick={retry}>
              Try again
            </button>
          </p>
        ) : !known ? (
          <p className="bc-note" role="status">
            {READING}
          </p>
        ) : chains.length === 0 ? (
          <p className="bc-note">{EMPTY}</p>
        ) : (
          <table className="bc-table" aria-label="Blocked chains">
            <thead>
              <tr className="bc-row bc-head">
                {CHAIN_COLUMNS.map((c, i) => (
                  <th
                    key={c}
                    scope="col"
                    className={i >= 4 ? "bc-num" : undefined}
                    aria-sort={i === 4 ? "descending" : undefined}
                  >
                    {i === 4 ? `${c} ▼` : c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chains.map((c) => (
                <ChainRows key={`${c.repoId}:${c.root.ref}`} chain={c} tracked={tracked} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}
