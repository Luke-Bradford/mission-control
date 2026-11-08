import {
  ANSWER_REFUSED,
  ASKING_RUN_ENDED_REASON,
  type AttentionItem,
  COMMS_MC,
  COMMS_OPEN_PREFIX,
  DROP_REFUSED,
  dropComment,
  hudColumnOf,
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
import { validateCommsText } from "./comms.ts";
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

/** Whether a live run other than the one waiting on the question works the ticket. */
const otherLiveRun = (store: Store, repoId: string, ref: string, waiting: string | null): boolean =>
  store
    .runsOnTicket(repoId, ref)
    .some((r) => r.endedAt === null && r.reviewId == null && r.id !== waiting);

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
  const asked = questionOf(c.store, c.config, item);
  if (asked === null) return "it is not a question a run or a seat asked";
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
  // a card parked under another run's feet would leave that run working it
  if (otherLiveRun(c.store, repo.id, `${repo.id}#${ref.number}`, asked.runId))
    return "the ticket has a live run";
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

/** A set-aside question as the Ticket page shows it. */
export interface SetAsideQuestion {
  id: number;
  /** What the seat asked. */
  text: string;
  /** FLIGHT's briefed ask for the operator, when it wrote one. */
  ask: string | null;
  options: { id: string; label: string; answer: string }[];
  asideAt: number;
  runId: string;
}

/** The ticket's set-aside questions nobody has answered, oldest first. */
export function setAsideQuestions(store: Store, repoId: string, issue: number): SetAsideQuestion[] {
  const ref = `${repoId}#${issue}`;
  const briefs = store.briefs();
  return store
    .asideQuestions()
    .filter((q) => store.run(q.runId)?.ticket === ref && q.asideAt !== null)
    .map((q) => {
      const brief = briefs.get(`ask:${q.id}`);
      return {
        id: q.id,
        text: q.text,
        ask: brief?.ask || null,
        options: (brief?.options ?? []).map((o) => ({
          id: o.id ?? o.label,
          label: o.label,
          answer: o.answer,
        })),
        asideAt: q.asideAt as number,
        runId: q.runId,
      };
    });
}

/**
 * The operator answers a set-aside question from its ticket: the text goes to the asking seat as a
 * Comms line on the ticket, `waiting:operator` comes off the issue, the card leaves the Backlog for
 * Ready (the next start of the ticket picks up the run's stored handoff), and the question closes
 * as answered. Each GitHub step is safe to repeat, so a 502 can be retried.
 */
export const answerSetAside = (
  c: NeedsYouContext,
  repoId: string,
  issue: number,
  id: number,
  text: string,
  /** Leaves the answer in the Comms line on the ticket, for the ended run only. */
  tell: (seatId: string, ticket: string, runId: string, text: string) => Promise<void>,
): Promise<ActionResult> =>
  once(`aside:${id}`, async () => {
    const refused = (status: number, why: string) => refuse(status, ANSWER_REFUSED, why);
    const ref = `${repoId}#${issue}`;
    const question = c.store.question(id);
    if (question === null || c.store.run(question.runId)?.ticket !== ref)
      return refused(404, "that question is not on this ticket");
    if (question.answeredAt !== null || question.asideAt === null)
      return refused(409, "that question is not set aside");
    const repo = c.config.repos.find((r) => r.id === repoId);
    if (repo === undefined) return refused(404, "unknown repo");
    try {
      await validateCommsText(c.knownSecrets, text);
    } catch (e) {
      return refused(
        400,
        e instanceof Error ? e.message.replace(/\.$/, "") : "the text is refused",
      );
    }
    const fail = (why: string) => refuse(502, ANSWER_REFUSED, why);
    const card = c.store.board(repoId).find((b) => b.issueNumber === issue);
    // the answer is stored first, where the ticket's next run reads it, so a failure below never
    // leaves the card in Ready with no answer; a retry replaces it
    c.store.recordSetAsideAnswer({
      at: c.now(),
      seatId: question.agentId,
      questionId: id,
      ref,
      about: question.text,
      decision: text,
    });
    try {
      const unlabelled = await c.gh(
        [
          "issue",
          "edit",
          String(issue),
          `--repo=${repo.github}`,
          `--remove-label=${WAITING_OPERATOR_LABEL}`,
        ],
        { cwd: crewDir(c.dbPath) },
      );
      if (unlabelled.code !== 0) {
        c.log?.(`answer ${ref}: gh issue edit failed (${String(unlabelled.code)})`);
        return fail("GitHub refused to remove the label");
      }
      // a card another hand moved, or a ticket a run now works, is left where it is
      if (
        card !== undefined &&
        !card.closed &&
        hudColumnOf(card) === "Backlog" &&
        !otherLiveRun(c.store, repoId, ref, null)
      ) {
        const moved = await c.board.move({ runId: question.runId, repoId, issue, column: "Ready" });
        if (!moved.ok) {
          c.log?.(`answer ${ref}: the card did not move: ${moved.reason}`);
          return fail("the card could not be moved to Ready");
        }
      }
      await tell(question.agentId, ref, question.runId, text);
    } catch (e) {
      c.log?.(`answer ${ref}: ${e instanceof Error ? e.message : "failed"}`);
      return fail("the answer could not be delivered; try again");
    }
    c.store.answerQuestion(id, c.now());
    c.bus.emit("attention");
    c.bus.emit("boards");
    c.bus.emit("agents");
    return { ok: true };
  });

/**
 * Takes `waiting:operator` off every open card that is outside the Backlog: someone moved it, so the
 * question no longer holds it. Returns how many labels it removed. It does nothing while a Not now
 * runs, which adds the label before it moves the card.
 */
export async function releaseWaitingOperator(
  c: Pick<NeedsYouContext, "config" | "store" | "gh" | "dbPath" | "log">,
): Promise<number> {
  if (inFlight.size > 0) return 0;
  let released = 0;
  for (const repo of c.config.repos) {
    // only the repo whose board the hub writes, the one Not now acts on
    if (repo.autonomy !== "merge" || repo.id !== flightSeat(c.config)?.session.repoId) continue;
    for (const card of c.store.board(repo.id)) {
      if (card.closed || hudColumnOf(card) === "Backlog") continue;
      if (!card.labels.includes(WAITING_OPERATOR_LABEL)) continue;
      try {
        const r = await c.gh(
          [
            "issue",
            "edit",
            String(card.issueNumber),
            `--repo=${repo.github}`,
            `--remove-label=${WAITING_OPERATOR_LABEL}`,
          ],
          { cwd: crewDir(c.dbPath) },
        );
        if (r.code === 0) released++;
        else c.log?.(`release ${repo.id}#${card.issueNumber}: gh issue edit failed (${r.code})`);
      } catch (e) {
        c.log?.(
          `release ${repo.id}#${card.issueNumber}: ${e instanceof Error ? e.message : "failed"}`,
        );
      }
    }
  }
  return released;
}
