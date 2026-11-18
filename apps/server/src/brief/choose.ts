import {
  type AttentionBrief,
  type AttentionItem,
  type ChoiceReceipt,
  type ChoiceTargetKind,
  COMMS_CAPCOM,
  COMMS_MC,
  COMMS_OPEN_PREFIX,
  type CommsSenderKind,
} from "@mc/core";
import { sendComms } from "../comms/index.ts";
import type { CcConfig } from "../config.ts";
import { flightSeat } from "../flight/seat.ts";
import { CREW_ERROR_KEY, NOTE_KEY } from "../hud/hud.ts";
import { commsPosition, type QuestionChoiceRow, type Store } from "../store.ts";

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
 * The refusals every pick passes, whichever route carries it: the item is still open, it is not
 * answered on GitHub, it has a brief the route takes (`takes`), the hub did not write that brief,
 * and it is the brief the page showed. Answers that brief.
 */
function pickableBrief(
  item: AttentionItem | undefined,
  briefAt: number,
  takes: (brief: AttentionBrief) => boolean,
): { item: AttentionItem; brief: AttentionBrief } {
  if (item === undefined) throw new ChoiceRefused(404, "That question is no longer open.");
  if (item.escalationId !== null)
    throw new ChoiceRefused(409, "That question is answered on GitHub, not here.");
  const brief = item.brief;
  if (brief === undefined || !takes(brief))
    throw new ChoiceRefused(409, "That question has no options for you to pick from.");
  // a brief the hub wrote acts through its own route (a queue change has Approve and Deny buttons)
  if (brief.by === "hub") throw new ChoiceRefused(409, "Use the item's own buttons for this one.");
  if (brief.at !== briefAt)
    throw new ChoiceRefused(
      409,
      "The question changed since you opened it. Reload and choose again.",
    );
  return { item, brief };
}

/** The choose route takes FLIGHT's briefs to the operator, and of those the options that carry an id. */
const forChooseRoute = (brief: AttentionBrief): boolean => brief.for === "operator";

/** The seat question behind an `ask:` key, refused once it is closed; null for any other key. */
function openQuestion(store: Store, key: string) {
  const ask = ASK.exec(key);
  const question = ask === null ? null : store.question(Number(ask[1]));
  if (ask !== null && (question === null || question.answeredAt !== null))
    throw new ChoiceRefused(409, "That question is already closed.");
  return question;
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
  const { item: open, brief } = pickableBrief(item, input.briefAt, forChooseRoute);
  const option = brief.options.find((o) => o.id !== undefined && o.id === input.optionId);
  if (option === undefined) throw new ChoiceRefused(400, "That is not one of the options.");

  const now = d.now();
  const flightId = flightSeat(d.config)?.seat.id ?? null;
  const question = openQuestion(store, key);

  // who asked: the seat behind an ask: question, or behind a seat's open Comms item; a seat's
  // other items name the seat but not the run, so their answer goes through FLIGHT
  let asker: { agentId: string; runId: string | null } | null = null;
  if (question !== null) asker = { agentId: question.agentId, runId: question.runId };
  else if (key.startsWith(COMMS_OPEN_PREFIX)) {
    const messageId = key.slice(COMMS_OPEN_PREFIX.length);
    const author = store.commsMessage(messageId)?.from;
    if (author !== undefined && author !== flightId && d.crew().includes(author))
      asker = { agentId: author, runId: store.commsStamp(messageId).runId };
  } else if (
    (open.kind === "tag" || open.kind === "message") &&
    open.agentId !== null &&
    open.agentId !== flightId &&
    d.crew().includes(open.agentId)
  ) {
    // built as `${kind}:${seat}:${message id}`: the seat wrote it, and its run is in the id
    const messageId = key.slice(`${open.kind}:${open.agentId}:`.length);
    const source = commsPosition(messageId)?.source ?? "";
    const runId = source.startsWith("stream:")
      ? source.slice("stream:".length)
      : store.commsStamp(messageId).runId;
    asker = { agentId: open.agentId, runId };
  }
  // any other item (a crew error, a stall, a lock, a note) is FLIGHT's to decide, not a seat's question

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
  const ticket = open.ticket ?? brief.ticket ?? null;
  const asked = brief.ask || open.text;
  const chooser = CHOOSER_NAMES[d.sender.kind];
  const lead = `Re: ${key} · ${chooser} chose "${option.label}"`;
  const text =
    targetKind === "flight-for-next-run"
      ? `${lead}\n\n${option.answer}\n\n${
          asker?.runId == null
            ? `The run that asked is not known; pass this on to ${asker?.agentId ?? "the seat"}'s run on ${ticket ?? "that ticket"}.`
            : `${asker.agentId}'s run that asked has ended. Pass this on to the next run on ${ticket ?? "that ticket"}.`
        }`
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
        itemKey: key,
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

/** Who may pick an option with a message: the senders the choose route is open to, and not FLIGHT. */
export const MESSAGE_PICK_SENDERS: readonly CommsSenderKind[] = ["operator", "controller"];

/** A pick claimed for an answer that travels as a plain message. */
export interface MessagePick {
  /**
   * The message is stored: the pick is tied to it, so the conversation draws it as the choice,
   * and a seat's question closes with it, as it does on the choose route.
   */
  sent(messageId: string): void;
  /** Nothing was stored: the operator can pick again. */
  release(): void;
}

/**
 * The operator picked an option that `chooseOption` does not take (an older brief whose options
 * carry no id, or a brief that is not FLIGHT's to the operator), so the answer goes as a plain
 * message to `message.to`. It passes the refusals every pick passes, and these of its own:
 * - the option is read from the stored brief by its place, and the text must be its answer;
 * - an option the choose route takes is picked there, not here;
 * - the message goes to the seat that asked (a seat's question, else the item's seat) while that
 *   seat is in the crew, and to FLIGHT otherwise, never to another seat;
 * - a pick sent to the seat that asked a question names that question, so the route delivers it
 *   to the run that asked and closes it; a named question is the pick's own.
 * The brief is claimed before the message is sent, as above. Null when the brief already has a
 * pick: nothing is sent twice.
 */
export function claimMessagePick(
  d: Pick<ChooseDeps, "store" | "now" | "sender" | "crew"> & { flightId: string | null },
  item: AttentionItem | undefined,
  key: string,
  input: { briefAt: number; option: number },
  message: { to: string; text: string; question?: number },
): MessagePick | null {
  const { store } = d;
  if (store.choice(key, input.briefAt) !== null) return null;
  const { item: open, brief } = pickableBrief(item, input.briefAt, () => true);
  const option = brief.options[input.option];
  if (option === undefined || option.answer !== message.text)
    throw new ChoiceRefused(400, "That is not one of the options.");
  if (forChooseRoute(brief) && option.id !== undefined)
    throw new ChoiceRefused(409, "That option is picked with the choose route, not a message.");
  const question = openQuestion(store, key);

  // who the answer is for: the seat that asked while it is in the crew, FLIGHT otherwise
  const asked = question?.agentId ?? open.agentId;
  const owner = asked !== null && d.crew().includes(asked) ? asked : d.flightId;
  if (owner === null) throw new ChoiceRefused(409, "There is no FLIGHT seat to take this answer.");
  if (message.to !== owner) throw new ChoiceRefused(409, "That question belongs to another seat.");
  if (message.question !== undefined && message.question !== question?.id)
    throw new ChoiceRefused(400, "The option picked is not for the question the message names.");
  // FLIGHT has no run set aside to route to: its own question closes with the pick, below
  if (question !== null && owner !== d.flightId && message.question === undefined)
    throw new ChoiceRefused(400, "A pick on a seat's question names that question.");

  const claimed = store.claimChoice({
    key,
    briefAt: input.briefAt,
    optionId: option.id ?? `option-${input.option + 1}`,
    label: option.label,
    answer: option.answer,
    question: brief.ask || open.text,
    ticket: open.ticket ?? brief.ticket ?? null,
    target: owner,
    targetKind: owner === d.flightId ? "flight" : "seat",
    messageId: null,
    chosenBy: CHOOSER_NAMES[d.sender.kind],
    chosenAt: d.now(),
  });
  if (!claimed.fresh) return null;
  return {
    sent: (messageId) => {
      store.setChoiceMessage(key, input.briefAt, messageId);
      if (question !== null) store.answerQuestion(question.id, d.now());
    },
    release: () => store.releaseChoice(key, input.briefAt),
  };
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
