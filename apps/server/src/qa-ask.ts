/** The operator asks QA a question about a PR; a review seat answers in a short read-only run. */
import { COMMS_MESSAGE_MAX, type CommsMessage, seatDef } from "@mc/core";
import { type CcConfig, seatUnavailable } from "./config.ts";
import type { Store } from "./store.ts";

/** Questions allowed per PR per local day. */
export const QA_ASK_DAILY_LIMIT = 5;
/** Tokens one answer run may use. */
export const QA_ASK_TOKEN_CAP = 100_000;
export const QA_ASK_TEXT_MAX = 1_000;
/** The only tools the answer run gets: read-only. */
export const QA_ASK_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

/** What the run gets: the PR's diff, tests, findings and the question are read from the seat's scratch checkout. */
export interface QaAskJob {
  seatId: string;
  repoId: string;
  pr: number;
  question: string;
  tokenCap: number;
  tools: readonly string[];
}

/** The run's result: the answer, and the tests and evidence it used. */
export interface QaAskResult {
  answer: string;
  sources: readonly string[];
  tokens: number;
}

export type QaAskRunner = (job: QaAskJob) => Promise<QaAskResult>;

export interface QaAskDeps {
  config: CcConfig;
  store: Store;
  now: () => number;
  /** Whether the seat has a run, a start or a turn on. */
  seatBusy: (seatId: string) => boolean;
  runner: QaAskRunner;
  send: (from: string, text: string, ref: string) => Promise<CommsMessage>;
}

export type QaAskOutcome =
  | { ok: true; message: CommsMessage; remaining: number }
  | { ok: false; status: 404 | 409 | 429 | 502 | 503; error: string };

export const qaAskKey = (repoId: string, pr: number, day: number): string =>
  `qa-ask:${repoId}:${pr}:${day}`;

/** Review seats of the repo, the one that last reviewed the PR first, then any free one. */
export function qaAskSeat(
  deps: Pick<QaAskDeps, "config" | "store" | "seatBusy">,
  repoId: string,
  pr: number,
): string | null {
  const seats = (deps.config.crew?.sessions ?? [])
    .filter((s) => s.repoId === repoId)
    .flatMap((s) => s.seats)
    .filter((s) => !s.retiring && !seatUnavailable(s) && seatDef(s).mode === "scratch")
    .map((s) => s.id);
  const last = deps.store.lastReviewSeat(repoId, pr);
  const order = last !== null && seats.includes(last) ? [last, ...seats] : seats;
  return order.find((id) => !deps.seatBusy(id)) ?? null;
}

const cut = (text: string, max: number): string =>
  Array.from(text).length <= max
    ? text
    : `${Array.from(text)
        .slice(0, max - 1)
        .join("")}…`;

export async function askQa(
  deps: QaAskDeps,
  input: { repoId: string; pr: number; text: string; day: number },
): Promise<QaAskOutcome> {
  const { repoId, pr, text } = input;
  if (deps.store.pullRequest(repoId, pr) === null)
    return { ok: false, status: 404, error: "unknown PR" };
  const key = qaAskKey(repoId, pr, input.day);
  const asked = Number(deps.store.getSetting(key) ?? "0");
  if (asked >= QA_ASK_DAILY_LIMIT) {
    return {
      ok: false,
      status: 429,
      error: `limit reached: ${QA_ASK_DAILY_LIMIT} questions per PR per day. Ask again tomorrow.`,
    };
  }
  const seatId = qaAskSeat(deps, repoId, pr);
  if (seatId === null)
    return { ok: false, status: 503, error: "no review seat is free to answer; try again soon" };
  // Counted before the run starts, so a failing run cannot be retried past the limit.
  deps.store.setSetting(key, String(asked + 1));
  let result: QaAskResult;
  try {
    result = await deps.runner({
      seatId,
      repoId,
      pr,
      question: text,
      tokenCap: QA_ASK_TOKEN_CAP,
      tools: QA_ASK_TOOLS,
    });
  } catch (e) {
    return {
      ok: false,
      status: 502,
      error: `QA could not answer: ${e instanceof Error ? e.message : "the run failed"}`,
    };
  }
  const used = result.sources.length > 0 ? `\nUsed: ${result.sources.join(", ")}` : "";
  const head = `Q: ${cut(text, 200)}\nA: `;
  const body = cut(result.answer, COMMS_MESSAGE_MAX - Array.from(head + used).length);
  const message = await deps.send(seatId, `${head}${body}${used}`, `PR ${pr}`);
  return { ok: true, message, remaining: QA_ASK_DAILY_LIMIT - asked - 1 };
}
