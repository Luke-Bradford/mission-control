import type { PrUatRound, PrUatView, PullRequestView } from "@mc/core";
import type { Store } from "./store.ts";

/** Comms shown on a PR's readiness card. */
export const PR_UAT_COMMS = 20;
/** Comms read per PR, so a rework round's reply is found even past the newest few. */
const COMMS_READ = 200;

export interface PrUatInput {
  store: Store;
  pr: PullRequestView;
  /** The repo's run command from config, if it has one. */
  runCommand: string | undefined;
  /** True when the hub serves one repo, so an unqualified `#n` can only mean this one. */
  singleRepo: boolean;
  /** The repo of the seat that sent a message, else null. */
  repoOfSender: (from: string) => string | null;
}

/** The branch as one shell word: bare when it is only safe characters, else single-quoted. */
const shellWord = (b: string): string =>
  /^[A-Za-z0-9._/-]+$/.test(b) ? b : `'${b.replace(/'/g, "'\\''")}'`;

/** Comms, rework rounds and try-it commands for one PR. */
export function prUat({ store, pr, runCommand, singleRepo, repoOfSender }: PrUatInput): PrUatView {
  const ticketNumber = pr.ticket === null ? null : /#(\d+)$/.exec(pr.ticket)?.[1];
  const all = store
    .commsOnTicket(
      pr.ticket ?? "",
      ticketNumber === null || ticketNumber === undefined ? "" : `#${ticketNumber}`,
      [`PR ${pr.number}`],
      COMMS_READ,
    )
    .filter((m) => m.ticket === pr.ticket || singleRepo || repoOfSender(m.from) === pr.repoId);

  const reviews = store
    .reviewsOfPr(pr.repoId, pr.number)
    .filter((v) => v.state === "reported")
    .sort((a, b) => a.round - b.round || a.id - b.id);
  const commits = store.commitsOnBranch(pr.repoId, pr.branch);
  const rounds: PrUatRound[] = reviews.map((v, i) => {
    const from = v.endedAt ?? v.createdAt;
    const until = reviews[i + 1]?.createdAt ?? Number.POSITIVE_INFINITY;
    const author = store.run(v.authorRunId)?.agentId;
    const blocking = store
      .findingsOf(v.id)
      .filter((f) => f.state === "open")
      .map((f) => ({
        severity: f.severity,
        file: f.file,
        line: f.line,
        summary: `${f.file}:${f.line} ${f.summary}`,
        resolved: f.resolution !== undefined && f.resolution !== "held",
      }));
    const reply = all.find((m) => m.from === author && m.at > from && m.at < until);
    return {
      round: v.round,
      reviewId: v.id,
      at: from,
      sha: v.sha,
      blocking: blocking.map(({ resolved: _, ...f }) => f),
      reply: reply === undefined ? null : { at: reply.at, from: reply.from, text: reply.text },
      fixSha: commits.find((c) => c.at > from && c.at < until)?.sha ?? null,
      result:
        blocking.length === 0 ? "clean" : blocking.every((f) => f.resolved) ? "resolved" : "open",
    };
  });

  return {
    repoId: pr.repoId,
    number: pr.number,
    comms: all.slice(0, PR_UAT_COMMS).map((m) => ({
      id: m.id,
      at: m.at,
      from: m.from,
      to: m.to,
      label: m.label,
      text: m.text,
    })),
    rounds: rounds.reverse(),
    tryIt: {
      branch: pr.branch,
      commands: [
        `git fetch origin ${shellWord(pr.branch)} && git switch ${shellWord(pr.branch)}`,
        ...(runCommand === undefined ? [] : [runCommand]),
      ],
      previewUrl: null,
    },
  };
}
