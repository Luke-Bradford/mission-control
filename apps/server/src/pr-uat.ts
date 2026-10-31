import {
  COMMS_CAPCOM,
  type PrUatRound,
  type PrUatView,
  type PullRequestView,
  UAT_PARK,
} from "@mc/core";
import type { Store } from "./store.ts";

/** Comms shown on a PR's readiness card. */
export const PR_UAT_COMMS = 20;
/** Comms read per PR, so a rework round's reply is found even past the newest few. */
const COMMS_READ = 200;

export interface PrUatInput {
  store: Store;
  pr: PullRequestView;
  /** The URL of the PR's running branch preview, else null. */
  previewUrl: string | null;
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

const SEND_BACK =
  /^The operator sent \w+ back at acceptance\.\n\n([\s\S]*)\n\nFix it, commit, and report again\.$/;

/** Whether the PR waits for acceptance, since when, and the operator's newest send-back note. */
function uatOf({ store, pr }: PrUatInput): PrUatView["uat"] {
  const run = store
    .loopRuns(0)
    .find((r) => r.repoId === pr.repoId && r.endedAt === null && r.loop?.prNumber === pr.number);
  const loop = run?.loop;
  if (run === undefined || !loop) return { waiting: false, since: null, note: null };
  const waiting = loop.parked?.kind === UAT_PARK && !loop.uat?.accepted;
  const since = waiting
    ? (store
        .loopEventsOfRun(run.id)
        .filter((e) => e.key === `${run.id}:${loop.epoch}:parked:uat:${loop.uat?.sha}`)
        .at(-1)?.at ?? null)
    : null;
  const sent = store
    .commsFromToRun(COMMS_CAPCOM, run.id, 20)
    .find((m) => SEND_BACK.test(m.text) || m.text.startsWith("Sent back at acceptance"));
  const note = sent === undefined ? null : (SEND_BACK.exec(sent.text)?.[1] ?? sent.text);
  return { waiting, since, note };
}

/** Comms, rework rounds and try-it commands for one PR. */
export function prUat(input: PrUatInput): PrUatView {
  const { store, pr, runCommand, previewUrl, singleRepo, repoOfSender } = input;
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
      previewUrl,
    },
    uat: uatOf(input),
  };
}
