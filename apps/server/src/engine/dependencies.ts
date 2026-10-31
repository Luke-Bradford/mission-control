/**
 * Release on merge: when what a ticket waited on is gone, a Blocked ticket that is otherwise
 * complete goes to Ready, and its open PRs are told to merge main. Each step is recorded on the
 * released wait, so it happens once and a failed step is tried again a while later.
 */
import {
  areaLabelsOf,
  hasDoneWhenSection,
  hudColumnOf,
  type PullRequestView,
  prCarries,
  type RepoRules,
  type TicketView,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import { observeWaits, patchReleased, type ReleasedWait } from "../dependencies.ts";
import type { Move, MoveResult } from "../github-board.ts";
import type { Store } from "../store.ts";
import type { RepoRulesError } from "./rules.ts";

/** A step that failed or was refused is tried again after this. */
export const RELEASE_RETRY_MS = 5 * 60_000;

export interface ReleaseDeps {
  store: Store;
  config: CcConfig;
  now: () => number;
  move: (m: Move) => Promise<MoveResult>;
  /** The engine's merge of main into a run's branch; `refused` is tried again later. */
  syncMain: (runId: string) => Promise<{ kind: "refused" | "merged" | "conflict" | "current" }>;
  rules: (repoId: string) => Promise<RepoRules | RepoRulesError>;
  fetchTicket: (repo: CcConfig["repos"][number], n: number) => Promise<TicketView | null>;
  /** The repo's PRs, read once per tick. */
  prsFor: (repoId: string) => readonly PullRequestView[];
  pollGithub?: () => void;
  log: (line: string) => void;
}

/** The run id a release's board move is recorded under. */
export const releaseMoveRunId = (ref: string): string => `dep:${ref}`;

export async function releaseDependents(d: ReleaseDeps): Promise<void> {
  const { store, config } = d;
  for (const repo of config.repos) {
    if (repo.autonomy !== "merge") continue;
    const at = d.now();
    const record = observeWaits(store, repo.id, at, d.prsFor(repo.id));
    for (const released of record.released) {
      if (released.moved === true && !hasPrsToSync(d, repo.id, released)) continue;
      if (released.triedAt !== undefined && at - released.triedAt < RELEASE_RETRY_MS) continue;
      try {
        await release(d, repo, released);
      } catch (e) {
        d.log(`release ${released.ref}: ${e instanceof Error ? e.message : String(e)}`);
        patchReleased(store, repo.id, released.ref, released.at, { triedAt: d.now() });
      }
    }
  }
}

const issueOf = (ref: string): number => Number(ref.slice(ref.lastIndexOf("#") + 1));

/** The ticket's open PRs not yet told to merge main. */
function openPrs(d: ReleaseDeps, repoId: string, released: ReleasedWait) {
  const issue = issueOf(released.ref);
  return d
    .prsFor(repoId)
    .filter(
      (p) =>
        p.state === "open" &&
        prCarries(p, repoId, issue) &&
        !(released.synced ?? []).includes(p.number),
    );
}

const hasPrsToSync = (d: ReleaseDeps, repoId: string, released: ReleasedWait): boolean =>
  openPrs(d, repoId, released).length > 0;

async function release(
  d: ReleaseDeps,
  repo: CcConfig["repos"][number],
  released: ReleasedWait,
): Promise<void> {
  const { store } = d;
  const issue = issueOf(released.ref);
  let failed = false;
  if (released.moved !== true) {
    const card = store.board(repo.id).find((c) => c.issueNumber === issue);
    if (card === undefined || card.closed || hudColumnOf(card) !== "Blocked") {
      patchReleased(store, repo.id, released.ref, released.at, { moved: true });
    } else {
      const rules = await d.rules(repo.id);
      const ticket = rules instanceof Error ? null : await d.fetchTicket(repo, issue);
      if (rules instanceof Error || ticket === null) {
        failed = true;
      } else {
        const complete =
          areaLabelsOf(rules, card).length === 1 &&
          rules.needs.every((n) =>
            n === "done_when" ? hasDoneWhenSection(ticket.body) : card.size !== null,
          );
        const moved = complete
          ? await d.move({
              runId: releaseMoveRunId(released.ref),
              repoId: repo.id,
              issue,
              column: "Ready",
            })
          : { ok: true as const, changed: false };
        if (moved.ok) {
          patchReleased(store, repo.id, released.ref, released.at, { moved: true });
          if (moved.changed) d.pollGithub?.();
        } else failed = true;
      }
    }
  }
  const synced = [...(released.synced ?? [])];
  const runs = store.loopRuns(d.now());
  for (const pr of openPrs(d, repo.id, released)) {
    const run = runs.find(
      (r) => r.endedAt === null && r.repoId === repo.id && r.loop?.prNumber === pr.number,
    );
    if (run !== undefined) {
      const result = await d.syncMain(run.id);
      if (result.kind === "refused") {
        failed = true;
        continue;
      }
      store.addLoopEvent(
        `${run.id}:dep-merged:${released.resolved.join("+")}`,
        run.id,
        `${released.resolved.join(", ")} landed; main merged into the branch`,
        d.now(),
      );
    }
    synced.push(pr.number);
  }
  patchReleased(store, repo.id, released.ref, released.at, {
    synced,
    ...(failed ? { triedAt: d.now() } : {}),
  });
}
