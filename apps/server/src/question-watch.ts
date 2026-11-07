import {
  ASKING_RUN_ENDED_REASON,
  COMMS_MC,
  COMMS_OPEN_PREFIX,
  OWNER_OPERATOR,
  prClosedReason,
  prMergedReason,
  type QuestionClosureKind,
  questionClosedText,
  ticketClosedReason,
} from "@mc/core";
import { protectedDecisionItem, questionAskAt } from "./attention-holds.ts";
import type { CcConfig } from "./config.ts";
import { flightSeat, ownReply } from "./flight/state.ts";
import { attentionItems, NO_LOCK, NOTE_KEY } from "./hud.ts";
import type { Store } from "./store.ts";

/** One open question the hub can close on a recorded fact: its ticket, PR and run. */
export interface QuestionSubject {
  key: string;
  /** When this ask began; with the key, the identity of the question. */
  askAt: number;
  question: string;
  /** `repo#n`, from the item or the run behind it. */
  ticket: string | null;
  runId: string | null;
  /** The seat that asked, told when the question closes. */
  seatId: string | null;
  /** The PR a `pr:` key names, else the run's PR; the newest PR closing the ticket is found later. */
  prNumber: number | null;
  /** Whether the operator has it in Needs you. */
  operator: boolean;
}

export interface QuestionFacts {
  ticket: "open" | "closed" | "none";
  pr: { number: number; state: "open" | "merged" | "closed"; headSha: string | null } | null;
  run: "live" | "ended" | "none" | `parked:${string}`;
}

/** The facts as one string, so a change in any shows as a change of the string. */
export const factsText = (f: QuestionFacts): string =>
  `ticket=${f.ticket};pr=${
    f.pr === null ? "none" : f.pr.state === "open" ? `open:${f.pr.headSha ?? ""}` : f.pr.state
  };run=${f.run}`;

/** The subject's id in the fact watch: one per key and ask. */
export const subjectId = (s: Pick<QuestionSubject, "key" | "askAt">): string =>
  `${s.key}@${s.askAt}`;

/** Open seat questions, and unprotected items with an operator brief or FLIGHT's own tag. */
export function openQuestionSubjects(d: {
  config: CcConfig;
  store: Store;
  now: number;
}): QuestionSubject[] {
  const { config, store, now } = d;
  const flightId = flightSeat(config)?.seat.id ?? null;
  const questions = new Map(store.openQuestions().map((q) => [`ask:${q.id}`, q]));
  const notes = new Map(store.notes().map((n) => [`${NOTE_KEY}${n.key}`, n]));
  const out: QuestionSubject[] = [];
  for (const item of attentionItems(config, store, now, NO_LOCK)) {
    const asked = questions.get(item.key);
    const seatQuestion = asked !== undefined && asked.agentId !== flightId ? asked : undefined;
    const operatorBrief = item.brief !== undefined && item.brief.for !== "flight";
    const ownTag = item.kind === "tag" && ownReply(item, flightId);
    if (seatQuestion === undefined && !operatorBrief && !ownTag) continue;
    if (protectedDecisionItem(store, item, config, now)) continue;
    let runId: string | null = null;
    let seatId: string | null = null;
    let question = item.brief?.ask || item.text;
    if (seatQuestion !== undefined) {
      runId = seatQuestion.runId;
      seatId = seatQuestion.agentId;
      question = seatQuestion.text;
    } else if (item.key.startsWith(COMMS_OPEN_PREFIX)) {
      const id = item.key.slice(COMMS_OPEN_PREFIX.length);
      const message = store.commsMessage(id);
      runId = store.commsRun(id)?.id ?? null;
      seatId = message?.from ?? null;
      question = message?.text ?? question;
    } else {
      runId = notes.get(item.key)?.runId ?? null;
    }
    const run = runId === null ? null : store.run(runId);
    const pr = /^pr:[^#]+#(\d+):/.exec(item.key);
    out.push({
      key: item.key,
      askAt: questionAskAt(item, item.brief),
      question,
      ticket: item.ticket ?? run?.ticket ?? null,
      runId,
      seatId: seatId !== null && store.seatSession(seatId) !== null ? seatId : null,
      prNumber: pr === null ? (run?.loop?.prNumber ?? null) : Number(pr[1]),
      operator: item.owner === OWNER_OPERATOR,
    });
  }
  return out;
}

/** What the store records now about the question's ticket, PR and run. */
export function questionFacts(store: Store, s: QuestionSubject): QuestionFacts {
  const ticket = /^(.+)#(\d+)$/.exec(s.ticket ?? "");
  const card = ticket === null ? null : store.boardItem(ticket[1] as string, Number(ticket[2]));
  const prs = ticket === null ? [] : store.pullRequests(ticket[1] as string);
  const found =
    s.prNumber !== null
      ? prs.find((p) => p.number === s.prNumber)
      : ticket === null
        ? undefined
        : prs
            .filter((p) => p.ticket === s.ticket || p.closingIssues?.includes(Number(ticket[2])))
            .sort((a, b) => b.number - a.number)[0];
  const run = s.runId === null ? null : store.run(s.runId);
  return {
    ticket: card === null ? "none" : card.closed ? "closed" : "open",
    pr:
      found === undefined
        ? null
        : { number: found.number, state: found.state, headSha: found.headSha },
    run:
      run === null
        ? "none"
        : run.endedAt !== null
          ? "ended"
          : run.loop?.parked
            ? `parked:${run.loop.parked.kind}`
            : "live",
  };
}

/** The first fact that settles the question: the run ended, the ticket closed, the PR merged or closed. */
export function closingFact(
  s: QuestionSubject,
  f: QuestionFacts,
): { kind: QuestionClosureKind; reason: string } | null {
  if (f.run === "ended") return { kind: "run-ended", reason: ASKING_RUN_ENDED_REASON };
  if (f.ticket === "closed" && s.ticket !== null)
    return { kind: "ticket-closed", reason: ticketClosedReason(s.ticket) };
  if (f.pr?.state === "merged") return { kind: "pr-merged", reason: prMergedReason(f.pr.number) };
  if (f.pr?.state === "closed") return { kind: "pr-closed", reason: prClosedReason(f.pr.number) };
  return null;
}

/**
 * Closes each open question a recorded fact has settled, tells its seat, and returns how many it
 * closed. A close is the hub's: it stores the closure and a Comms line to the seat, delivered while
 * the seat's run is live.
 */
export async function closeSettledQuestions(d: {
  config: CcConfig;
  store: Store;
  now: number;
  deliver?: (seatId: string, text: string) => Promise<void>;
}): Promise<number> {
  const { store, now } = d;
  let closed = 0;
  for (const s of openQuestionSubjects(d)) {
    const closing = closingFact(s, questionFacts(store, s));
    if (closing === null) continue;
    const stored = store.closeQuestion({
      key: s.key,
      askAt: s.askAt,
      kind: closing.kind,
      reason: closing.reason,
      by: "hub",
      question: s.question,
      ticket: s.ticket,
      operator: s.operator,
      at: now,
    });
    if (!stored) continue;
    closed++;
    if (s.key.startsWith(COMMS_OPEN_PREFIX))
      store.settleCommsItem(s.key.slice(COMMS_OPEN_PREFIX.length), COMMS_MC, closing.reason, now);
    if (s.seatId === null) continue;
    const text = questionClosedText(s.question, closing.reason);
    store.addComms({ at: now, from: COMMS_MC, to: s.seatId, ticket: s.ticket, text });
    const live = s.runId !== null && store.run(s.runId)?.endedAt === null;
    if (live && d.deliver !== undefined) {
      try {
        await d.deliver(s.seatId, text);
      } catch {
        // the Comms line stands; the seat reads it on its next turn
      }
    }
  }
  return closed;
}
