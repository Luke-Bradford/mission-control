import {
  type AttentionItem,
  type ChoiceReceipt,
  type ChoiceTargetKind,
  COMMS_CAPCOM,
  COMMS_MC,
  COMMS_OPEN_PREFIX,
  type CommsSenderKind,
} from "@mc/core";
import { sendComms } from "./comms.ts";
import type { CcConfig } from "./config.ts";
import { flightSeat } from "./flight/seat.ts";
import { CREW_ERROR_KEY, NOTE_KEY } from "./hud.ts";
import type { QuestionChoiceRow, Store } from "./store.ts";

/** What a choice route sends back when it refuses: the status and one plain line. */
export class ChoiceRefused extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, text: string) {
    super(text);
    this.status = status;
  }
}

export interface ChooseDeps {
  config: CcConfig;
  store: Store;
  now: () => number;
  crew: () => readonly string[];
  knownSecrets: () => Promise<readonly string[]>;
  /** Who is choosing, set by the hub from how the request was made: the operator, FLIGHT or the controller. */
  sender: { from: string; kind: CommsSenderKind };
  /** Wakes the seat so it takes its inbox; delivery state is set when it does. */
  wake: (seatId: string) => void;
  /** Wakes a run set aside by the engine, which is not the run on its seat. */
  reconcileRun?: (runId: string) => Promise<void>;
}

const ASK = /^ask:(\d+)$/;

/** How the chooser is named in the answer, the note to FLIGHT and the ticket's history. */
export const CHOOSER_NAMES: Record<CommsSenderKind, string> = {
  operator: "the operator",
  controller: "the controller",
  flight: "FLIGHT",
  seat: "a seat",
  hub: "the hub",
};

const receipt = (store: Store, row: QuestionChoiceRow, alreadyChosen: boolean): ChoiceReceipt => ({
  key: row.key,
  optionId: row.optionId,
  label: row.label,
  to: row.target,
  target: row.targetKind,
  chosenAt: row.chosenAt,
  deliveredAt:
    row.messageId === null ? null : (store.commsMessage(row.messageId)?.deliveredAt ?? null),
  alreadyChosen,
});

/** The receipt of the newest choice on a key, with the delivery time read now; null when none. */
export function choiceReceipt(store: Store, key: string): ChoiceReceipt | null {
  const row = store.latestChoice(key);
  return row === null ? null : receipt(store, row, true);
}

/**
 * The operator picked one option of an item's brief. Only the bound ids pick an option: the brief
 * the page showed (`briefAt`) and one of its option ids. The answer goes to the run that asked, or
 * to FLIGHT; the question closes; the choice is stored for the ticket's history. Nothing goes to
 * GitHub.
 */
export async function chooseOption(
  d: ChooseDeps,
  item: AttentionItem | undefined,
  key: string,
  input: { optionId: string; briefAt: number },
): Promise<ChoiceReceipt> {
  const { store } = d;
  const again = store.choice(key, input.briefAt);
  if (again !== null) return receipt(store, again, true);
  if (item === undefined) throw new ChoiceRefused(404, "That question is no longer open.");
  if (item.escalationId !== null)
    throw new ChoiceRefused(409, "That question is answered on GitHub, not here.");
  const brief = item.brief;
  if (brief === undefined || brief.for !== "operator")
    throw new ChoiceRefused(409, "That question has no options for you to pick from.");
  // a brief the hub wrote acts through its own route (a queue change has Approve and Deny buttons)
  if (brief.by === "hub") throw new ChoiceRefused(409, "Use the item's own buttons for this one.");
  if (brief.at !== input.briefAt)
    throw new ChoiceRefused(
      409,
      "The question changed since you opened it. Reload and choose again.",
    );
  const option = brief.options.find((o) => o.id !== undefined && o.id === input.optionId);
  if (option === undefined) throw new ChoiceRefused(400, "That is not one of the options.");

  const now = d.now();
  const flightId = flightSeat(d.config)?.seat.id ?? null;
  const ask = ASK.exec(key);
  const question = ask === null ? null : store.question(Number(ask[1]));
  if (ask !== null && (question === null || question.answeredAt !== null))
    throw new ChoiceRefused(409, "That question is already closed.");

  // who asked: the seat behind an ask: question, or behind a seat's open Comms item; a seat's
  // other items name the seat but not the run, so their answer goes through FLIGHT
  let asker: { agentId: string; runId: string | null } | null = null;
  if (question !== null) asker = { agentId: question.agentId, runId: question.runId };
  else if (key.startsWith(COMMS_OPEN_PREFIX)) {
    const messageId = key.slice(COMMS_OPEN_PREFIX.length);
    const author = store.commsMessage(messageId)?.from;
    if (author !== undefined && author !== flightId && d.crew().includes(author))
      asker = { agentId: author, runId: store.commsStamp(messageId).runId };
  } else if (item.agentId !== null && item.agentId !== flightId && d.crew().includes(item.agentId))
    asker = { agentId: item.agentId, runId: null };

  // where the answer goes: the run that asked while it lives, FLIGHT otherwise, never another run
  let to: string;
  let targetKind: ChoiceTargetKind;
  let runId: string | undefined;
  if (asker?.runId != null && store.run(asker.runId)?.endedAt === null) {
    to = asker.agentId;
    targetKind = "seat";
    runId = asker.runId;
  } else {
    if (flightId === null)
      throw new ChoiceRefused(409, "There is no FLIGHT seat to take this answer.");
    to = flightId;
    targetKind = asker === null ? "flight" : "flight-for-next-run";
  }
  const ticket = item.ticket ?? brief.ticket ?? null;
  const asked = brief.ask || item.text;
  const chooser = CHOOSER_NAMES[d.sender.kind];
  const lead = `Re: ${key} · ${chooser} chose "${option.label}"`;
  const text =
    targetKind === "flight-for-next-run"
      ? `${lead}\n\n${option.answer}\n\n${asker?.agentId ?? "The seat"}'s run that asked has ended. Pass this on to the next run on ${ticket ?? "that ticket"}.`
      : `${lead}\n\n${option.answer}`;

  // Claim the brief before anything is sent, with no wait in between: a second pick at the same
  // moment finds the claim and gets the first receipt, and nothing is delivered twice.
  const claimed = store.claimChoice({
    key,
    briefAt: input.briefAt,
    optionId: input.optionId,
    label: option.label,
    answer: option.answer,
    question: asked,
    ticket,
    target: to,
    targetKind,
    messageId: null,
    chosenBy: chooser,
    chosenAt: now,
  });
  if (!claimed.fresh) return receipt(store, claimed.row, true);

  try {
    const sent = await sendComms(
      {
        store,
        crew: d.crew,
        knownSecrets: d.knownSecrets,
        now: d.now,
        seatSender: false,
        senderKind: d.sender.kind,
        wakeUnlabelled: true,
        // a run set aside is woken by the engine below, not through the run on its seat
        notify: (seatId) => {
          if (runId === undefined || store.seatSession(seatId)?.runId === runId) d.wake(seatId);
        },
      },
      d.sender.from,
      {
        to,
        text,
        ...(ticket === null ? {} : { ref: ticket }),
        ...(runId === undefined ? {} : { targetRunId: runId }),
      },
    );
    store.setChoiceMessage(key, input.briefAt, sent.id);
  } catch (e) {
    // nothing was stored or delivered: let the operator choose again
    store.releaseChoice(key, input.briefAt);
    throw new ChoiceRefused(400, e instanceof Error ? e.message : "The answer could not be sent.");
  }
  // Close the question before waking a set-aside run: the engine holds a run while its question is open.
  // close the question; the ticket's history reads the stored choice
  if (question !== null) store.answerQuestion(question.id, now);
  else closeItem(store, key, now);

  // The answer is stored, so the choice stands even if waking the run fails (its next turn takes it).
  if (runId !== undefined && store.seatSession(to)?.runId !== runId) {
    try {
      await d.reconcileRun?.(runId);
    } catch {
      // the answer waits in the run's inbox
    }
  }

  // FLIGHT hears of a seat's answer in one line at its next wake; this wakes no one
  if (targetKind === "seat" && flightId !== null && flightId !== to && flightId !== d.sender.from)
    store.addComms({
      at: now,
      from: COMMS_MC,
      senderKind: "hub",
      to: flightId,
      ticket,
      text: `${chooser[0]?.toUpperCase()}${chooser.slice(1)} chose "${option.label}" for ${to}'s question${ticket === null ? "" : ` on ${ticket}`}; it is delivered to the run.`,
    });
  return receipt(store, claimed.row, false);
}

/** Takes a non-question item out of Needs you the way its own source does, then acks it. */
function closeItem(store: Store, key: string, at: number): void {
  if (key.startsWith(NOTE_KEY)) store.dismissNote(key.slice(NOTE_KEY.length), at);
  else if (key.startsWith(CREW_ERROR_KEY)) {
    const id = Number(key.slice(CREW_ERROR_KEY.length));
    if (Number.isSafeInteger(id) && id > 0) store.ackCrewError(id);
  } else if (key.startsWith(COMMS_OPEN_PREFIX))
    store.settleCommsItem(
      key.slice(COMMS_OPEN_PREFIX.length),
      COMMS_CAPCOM,
      "Chosen in Needs you",
      at,
    );
  store.ack([key], at);
}
