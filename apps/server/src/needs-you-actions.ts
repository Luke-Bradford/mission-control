import {
  ASKING_RUN_ENDED_REASON,
  type AttentionItem,
  COMMS_MC,
  COMMS_OPEN_PREFIX,
  DROP_REFUSED,
  dropComment,
  NEEDS_YOU_OFFERS,
  type NeedsYouOffer,
  NOT_NOW_REFUSED,
  notNowComment,
  OWNER_OPERATOR,
  type RepoRules,
  type TicketView,
  ticketClosedReason,
  WAITING_OPERATOR_COLOR,
  WAITING_OPERATOR_LABEL,
} from "@mc/core";
import { protectedDecisionItem, questionAskAt } from "./attention-holds.ts";
import type { ChangeBus } from "./bus.ts";
import type { Gql } from "./collectors/github.ts";
import type { CcConfig } from "./config.ts";
import type { RepoRulesError } from "./engine/rules.ts";
import { flightSeat } from "./flight/seat.ts";
import { cardProblem, closeBlocker } from "./flight/ticket-close.ts";
import type { Move, MoveResult } from "./github-board.ts";
import { ensureLabels } from "./github-setup.ts";
import type { GhRunner } from "./mcp/gh.ts";
import { prTextProblem, readKnown } from "./mcp/tools.ts";
import { recordRunHandoff } from "./run-handoffs.ts";
import type { Supervisor } from "./runtime/supervisor.ts";
import { parseTicket } from "./runview.ts";
import { crewDir, type Store } from "./store.ts";

/** What the routes need from the hub besides the store: the board, the repo rules and GitHub. */
export interface NeedsYouDeps {
  board: { move: (m: Move) => Promise<MoveResult> };
  rules: (repoId: string) => Promise<RepoRules | RepoRulesError>;
  fetchTicket: (repo: CcConfig["repos"][number], n: number) => Promise<TicketView | null>;
}

export interface NeedsYouContext extends NeedsYouDeps {
  config: CcConfig;
  store: Store;
  bus: ChangeBus;
  gh: GhRunner;
  gql: () => Promise<Gql>;
  dbPath: string;
  knownSecrets: () => Promise<readonly string[]>;
  supervisor?: Pick<Supervisor, "endRun" | "endAsideRun">;
  items: () => AttentionItem[];
  now: () => number;
  log?: (line: string) => void;
}

export type ActionResult = { ok: true } | { ok: false; status: number; error: string };

const refuse = (status: number, prefix: string, why: string): ActionResult => ({
  ok: false,
  status,
  error: `${prefix} ${why}.`,
});

/** The question behind an item the operator can set aside or drop: only a seat's or a Comms one. */
function questionOf(
  store: Store,
  config: CcConfig,
  item: AttentionItem,
): { text: string; runId: string | null; seatQuestion: number | null } | null {
  if (item.key.startsWith("ask:")) {
    const id = Number(item.key.slice("ask:".length));
    const q = Number.isInteger(id) ? store.question(id) : null;
    return q === null || q.answeredAt !== null || q.asideAt !== null
      ? null
      : { text: q.text, runId: q.runId, seatQuestion: id };
  }
  if (item.key.startsWith(COMMS_OPEN_PREFIX)) {
    const id = item.key.slice(COMMS_OPEN_PREFIX.length);
    const message = store.commsMessage(id);
    if (message === null) return null;
    // a run waits on the question only when it is a crew seat's own run on this ticket: the
    // sender's run at send time may be FLIGHT's or on other work, and ending it would be wrong
    const run = store.commsRun(id);
    const waiting =
      run !== null &&
      run.ticket === item.ticket &&
      run.agentId !== flightSeat(config)?.seat.id &&
      run.reviewId == null;
    return { text: message.text, runId: waiting ? run.id : null, seatQuestion: null };
  }
  return null;
}

/** Why Not now and Drop are not offered on `item`, in words; null when they are. */
export function offerProblem(
  c: Pick<NeedsYouContext, "config" | "store" | "now">,
  item: AttentionItem,
): string | null {
  if (item.kind !== "question" || item.owner !== OWNER_OPERATOR)
    return "only a question that waits for you can be set aside or dropped";
  // FLIGHT's own question is the operator's to answer; setting it aside would end FLIGHT
  if (item.agentId !== null && item.agentId === flightSeat(c.config)?.seat.id)
    return "it is FLIGHT's own question";
  if (questionOf(c.store, c.config, item) === null)
    return "it is not a question a run or a seat asked";
  if (protectedDecisionItem(c.store, item, c.config, c.now()))
    return "it is protected and always reaches you";
  const ref = item.ticket === null ? null : parseTicket(item.ticket);
  if (ref === null) return "it has no ticket";
  const repo = c.config.repos.find((r) => r.id === ref.repoId);
  if (repo === undefined || ref.repoId !== flightSeat(c.config)?.session.repoId)
    return "its ticket is not on this hub's repo";
  if (repo.autonomy !== "merge") return "this repo's board is not written by the hub";
  if (!c.store.board(repo.id).some((b) => b.issueNumber === ref.number && !b.closed))
    return "its ticket is not on this repo's board";
  return null;
}

/** The offers to put on an item. */
export const offersFor = (
  c: Pick<NeedsYouContext, "config" | "store" | "now">,
  item: AttentionItem,
): NeedsYouOffer[] | undefined =>
  offerProblem(c, item) === null ? [...NEEDS_YOU_OFFERS] : undefined;

type Target =
  | { ok: false; result: ActionResult }
  | {
      ok: true;
      item: AttentionItem;
      repo: CcConfig["repos"][number];
      issue: number;
      ref: string;
      title: string;
      question: NonNullable<ReturnType<typeof questionOf>>;
    };

async function targetOf(c: NeedsYouContext, key: string, prefix: string): Promise<Target> {
  const stop = (status: number, why: string): Target => ({
    ok: false,
    result: refuse(status, prefix, why),
  });
  const item = c.items().find((i) => i.key === key);
  if (item === undefined) return stop(404, "the question is no longer waiting");
  const problem = offerProblem(c, item);
  if (problem !== null) return stop(409, problem);
  const ref = parseTicket(item.ticket ?? "");
  const repo = c.config.repos.find((r) => r.id === ref?.repoId);
  const question = questionOf(c.store, c.config, item);
  if (ref === null || repo === undefined || question === null)
    return stop(409, "the question is no longer waiting");
  const card = c.store.board(repo.id).find((b) => b.issueNumber === ref.number);
  if (card === undefined || card.closed) return stop(409, "its ticket is not on this repo's board");
  const rules = await c.rules(repo.id);
  if (rules instanceof Error) return stop(409, "the repo's rules cannot be read");
  const bad = cardProblem(c.config, card, rules);
  if (bad !== null) return stop(409, bad);
  return {
    ok: true,
    item,
    repo,
    issue: ref.number,
    ref: `${repo.id}#${ref.number}`,
    title: card.title,
    question,
  };
}

/** Keys with an action in flight: a double click must not post a second comment. */
const inFlight = new Set<string>();
async function once(key: string, act: () => Promise<ActionResult>): Promise<ActionResult> {
  if (inFlight.has(key)) return refuse(409, "Not done:", "that question is already being handled");
  inFlight.add(key);
  try {
    return await act();
  } finally {
    inFlight.delete(key);
  }
}

/** Ends the run that waits on the question (if it is live) and records its handoff. */
async function endWaitingRun(c: NeedsYouContext, runId: string): Promise<void> {
  const run = c.store.run(runId);
  if (run === null) return;
  if (run.endedAt === null) {
    if (c.supervisor === undefined) throw new Error("the crew is off");
    if (c.store.seatSession(run.agentId)?.runId === run.id)
      await c.supervisor.endRun(run.agentId, { hold: false });
    else if (run.loop?.aside) await c.supervisor.endAsideRun(run.id);
    else throw new Error("the run is not on its seat");
  }
  const ended = c.store.run(runId);
  if (ended !== null) recordRunHandoff(c.store, ended, null);
}

/**
 * Not now: the question is set aside, its waiting run ends with a handoff, and the card moves to
 * the Backlog with `waiting:operator` and one comment. The question stays answerable on the
 * Ticket page.
 */
export const notNow = (c: NeedsYouContext, key: string): Promise<ActionResult> =>
  once(key, () => notNowOnce(c, key));

async function notNowOnce(c: NeedsYouContext, key: string): Promise<ActionResult> {
  const t = await targetOf(c, key, NOT_NOW_REFUSED);
  if (!t.ok) return t.result;
  const { repo, issue, ref, question, item } = t;
  const fail = (why: string) => refuse(502, NOT_NOW_REFUSED, why);
  let commentFailed = false;
  const at = c.now();
  const comment = notNowComment(
    item.brief?.ask || question.text,
    item.brief?.options ?? [],
    at,
    WAITING_OPERATOR_LABEL,
  );
  const unfit = prTextProblem(comment, {
    repo: repo.github,
    issue,
    known: await readKnown({ knownSecrets: c.knownSecrets }, "not_now"),
    label: "comment",
    allowOwnRepoRefs: true,
  });
  if (unfit !== null)
    return refuse(422, NOT_NOW_REFUSED, "the question's text cannot go in a GitHub comment");
  if (question.seatQuestion !== null && !c.store.setQuestionAside(question.seatQuestion, at))
    return refuse(404, NOT_NOW_REFUSED, "the question is no longer waiting");
  const putBack = () => {
    if (question.seatQuestion !== null) c.store.clearQuestionAside(question.seatQuestion);
    c.bus.emit("attention");
  };
  // the card first: a failure here changes nothing the operator cannot retry
  try {
    await ensureLabels(await c.gql(), repo.github, [
      { name: WAITING_OPERATOR_LABEL, color: WAITING_OPERATOR_COLOR },
    ]);
    const labelled = await c.gh(
      [
        "issue",
        "edit",
        String(issue),
        `--repo=${repo.github}`,
        `--add-label=${WAITING_OPERATOR_LABEL}`,
      ],
      { cwd: crewDir(c.dbPath) },
    );
    if (labelled.code !== 0) {
      c.log?.(`not now ${ref}: gh issue edit failed (${String(labelled.code)})`);
      putBack();
      return fail("GitHub refused the label");
    }
    const moved = await c.board.move({
      runId: question.runId ?? "operator",
      repoId: repo.id,
      issue,
      column: "Backlog",
    });
    if (!moved.ok) {
      c.log?.(`not now ${ref}: the card did not move: ${moved.reason}`);
      putBack();
      return fail("the card could not be moved to the Backlog");
    }
  } catch (e) {
    c.log?.(`not now ${ref}: ${e instanceof Error ? e.message : "failed"}`);
    putBack();
    return fail("GitHub could not be reached");
  }
  try {
    if (question.runId !== null) await endWaitingRun(c, question.runId);
  } catch (e) {
    c.log?.(`not now ${ref}: could not end the run: ${e instanceof Error ? e.message : "failed"}`);
    putBack();
    return fail("the waiting run could not be ended");
  }
  // the run has ended: whatever follows, the question stays aside (its run cannot be asked again)
  try {
    const commented = await c.gh(
      ["issue", "comment", String(issue), `--repo=${repo.github}`, `--body=${comment}`],
      { cwd: crewDir(c.dbPath) },
    );
    if (commented.code !== 0) {
      c.log?.(`not now ${ref}: gh issue comment failed (${String(commented.code)})`);
      commentFailed = true;
    }
  } catch (e) {
    c.log?.(`not now ${ref}: ${e instanceof Error ? e.message : "failed"}`);
    commentFailed = true;
  }
  if (question.seatQuestion === null && key.startsWith(COMMS_OPEN_PREFIX))
    c.store.settleCommsItem(
      key.slice(COMMS_OPEN_PREFIX.length),
      COMMS_MC,
      "Set aside by the operator.",
      at,
    );
  c.bus.emit("attention");
  c.bus.emit("boards");
  c.bus.emit("agents");
  if (commentFailed)
    return fail("the card moved and the run ended, but GitHub refused the comment; add it by hand");
  return { ok: true };
}

/** Drop: the ticket closes as not planned with one comment, under the refusals of close_ticket. */
export const drop = (c: NeedsYouContext, key: string): Promise<ActionResult> =>
  once(key, () => dropOnce(c, key));

async function dropOnce(c: NeedsYouContext, key: string): Promise<ActionResult> {
  const t = await targetOf(c, key, DROP_REFUSED);
  if (!t.ok) return t.result;
  const { repo, issue, ref } = t;
  const card = c.store.board(repo.id).find((b) => b.issueNumber === issue);
  if (card === undefined)
    return refuse(409, DROP_REFUSED, "its ticket is not on this repo's board");
  const closable = await closeBlocker(
    {
      store: c.store,
      gh: c.gh,
      dbPath: c.dbPath,
      fetchTicket: c.fetchTicket,
      ...(c.log === undefined ? {} : { log: c.log }),
    },
    "drop",
    repo,
    card,
    t.question.runId ?? undefined,
  );
  if ("refusal" in closable) return refuse(409, DROP_REFUSED, closable.refusal);
  const at = c.now();
  const { question } = t;
  if (question.seatQuestion !== null && !c.store.setQuestionAside(question.seatQuestion, at))
    return refuse(404, DROP_REFUSED, "the question is no longer waiting");
  const putBack = () => {
    if (question.seatQuestion !== null) c.store.clearQuestionAside(question.seatQuestion);
    c.bus.emit("attention");
  };
  /** The run has ended, so the question closes as run-ended (as when any run ends) and stays gone. */
  const closeRunEnded = () => {
    if (question.seatQuestion !== null)
      c.store.closeQuestion({
        key,
        askAt: questionAskAt(t.item, t.item.brief),
        kind: "run-ended",
        reason: ASKING_RUN_ENDED_REASON,
        by: "hub",
        question: question.text,
        ticket: ref,
        operator: true,
        at,
      });
    c.bus.emit("attention");
  };
  const stop = () => (question.runId === null ? putBack() : closeRunEnded());
  try {
    if (question.runId !== null) await endWaitingRun(c, question.runId);
  } catch (e) {
    c.log?.(`drop ${ref}: could not end the run: ${e instanceof Error ? e.message : "failed"}`);
    putBack();
    return refuse(502, DROP_REFUSED, "the waiting run could not be ended");
  }
  const closed = await c.gh(
    [
      "issue",
      "close",
      String(issue),
      `--repo=${repo.github}`,
      "--reason=not planned",
      `--comment=${dropComment(at)}`,
    ],
    { cwd: crewDir(c.dbPath) },
  );
  if (closed.code !== 0) {
    c.log?.(`drop ${ref}: gh issue close failed (${String(closed.code)})`);
    stop();
    return refuse(502, DROP_REFUSED, "GitHub refused the close");
  }
  // exit 0 is not proof: only the live issue, closed at or after the call began, counts
  let after: TicketView | null = null;
  try {
    after = await c.fetchTicket(repo, issue);
  } catch {
    after = null;
  }
  if (after?.state !== "closed" || (after.closedAt ?? 0) < at - 1000) {
    stop();
    return refuse(502, DROP_REFUSED, "GitHub did not confirm the close; read the ticket");
  }
  // the question is over with its ticket
  if (question.seatQuestion !== null)
    c.store.closeQuestion({
      key,
      askAt: questionAskAt(t.item, t.item.brief),
      kind: "ticket-closed",
      reason: ticketClosedReason(ref),
      by: "hub",
      question: question.text,
      ticket: ref,
      operator: true,
      at,
    });
  else
    c.store.settleCommsItem(
      key.slice(COMMS_OPEN_PREFIX.length),
      COMMS_MC,
      ticketClosedReason(ref),
      at,
    );
  c.bus.emit("attention");
  c.bus.emit("boards");
  c.bus.emit("agents");
  return { ok: true };
}
