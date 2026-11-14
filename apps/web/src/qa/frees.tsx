import type { DependencyChain, PullRequestSummary } from "@mc/core";
import { ticketPath } from "../router.ts";

export const FREES_SHOWN = 5;
const enc = encodeURIComponent;

type PrIdentity = Pick<PullRequestSummary, "repoId" | "number" | "ticket">;

/** The chain this PR roots: named by its number, or by its ticket once the hub has mapped it. */
export function chainFor(
  chains: readonly DependencyChain[],
  pr: PrIdentity,
): DependencyChain | undefined {
  return chains.find(
    (c) =>
      c.repoId === pr.repoId &&
      (c.root.ref === `PR ${pr.number}` || (pr.ticket !== null && c.root.ref === pr.ticket)),
  );
}

/** A ref as the app links it: a ticket opens its page, a PR opens QA, anything else is plain text. */
function Ref({ value, repoId }: { value: string; repoId: string }) {
  const pr = /^(?:(\S+) )?PR (\d+)$/.exec(value);
  const tk = /^(.*[^#\s])#(\d+)$/.exec(value);
  const href = pr
    ? `/qa?repo=${enc(pr[1] ?? repoId)}&pr=${pr[2]}`
    : tk
      ? ticketPath(tk[1] ?? repoId, Number(tk[2]))
      : null;
  return href ? <a href={href}>{value}</a> : <span>{value}</span>;
}

/** What merging this PR frees, for the decision panel. */
export function FreesLine({
  chain,
  repoId,
}: {
  chain: DependencyChain | undefined;
  repoId: string;
}) {
  if (!chain || (!chain.frees.length && !chain.stillWaiting.length)) return null;
  const more = chain.frees.length - FREES_SHOWN;
  return (
    <div className="uat-frees">
      <h3>Merging this frees {chain.frees.length}</h3>
      <ul>
        {chain.frees.slice(0, FREES_SHOWN).map((r) => (
          <li key={r}>
            <Ref value={r} repoId={chain.repoId || repoId} />
          </li>
        ))}
        {more > 0 && (
          <li>
            <a href="/flight#chainsP">+{more}</a>
          </li>
        )}
      </ul>
      {chain.stillWaiting.length > 0 && (
        <p className="uat-frees-more">{chain.stillWaiting.length} more also wait on other work</p>
      )}
    </div>
  );
}

/** The queue row's `unblocks n ·` lead-in; nothing when the merge frees nothing. */
export function UnblocksMark({ count }: { count: number }) {
  return count > 0 ? `unblocks ${count} · ` : null;
}
