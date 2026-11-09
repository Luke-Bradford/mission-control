import { dayMonth, hhmm, isoDay } from "../../fmt.ts";
import type { FlightDecision } from "../flightTypes.ts";

/** An ISO time (`2026-11-08T11:45:00.000Z`), the hub's compact form (`20261106T170333Z`) or epoch ms. */
const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/g;
const COMPACT = /\b(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\b/g;
const EPOCH_MS = /\b1\d{12}\b/g;

/** `11:45` today, `8 Nov 11:45` on another day, in the operator's time zone. */
export function whenLabel(ms: number, now: number, tz: string): string {
  return isoDay(ms, tz) === isoDay(now, tz) ? hhmm(ms, tz) : `${dayMonth(ms, tz)} ${hhmm(ms, tz)}`;
}

/** An internal message id (`comms:2799`): it has no page the operator can open. */
const COMMS_ID = /\bcomms:\d+\b/g;

/** Text with every machine time written as the operator reads it, and internal message ids named in words. */
export function readableText(text: string, now: number, tz: string): string {
  const at = (ms: number, raw: string) => (Number.isFinite(ms) ? whenLabel(ms, now, tz) : raw);
  return text
    .replace(/\b(?:immutable\s+)?(?:QA\s+)?report\s+[a-f0-9]{64}\b/gi, "the review report")
    .replace(/\b[a-f0-9]{64}\b/gi, "the review report")
    .replace(/\bPR(\d+)\b/g, "PR $1")
    .replace(/\bhead\s*([a-f0-9]{7,40})\b/gi, (_raw, sha: string) => `head ${sha.slice(0, 8)}`)
    .replace(/\breview(\d+)\b/gi, "review $1")
    .replace(/\b(closing|closed|issue|ticket)(\d+)\b/gi, "$1 #$2")
    .replace(/\b[a-f0-9]{40}\b/gi, (sha) => `commit ${sha.slice(0, 8)}`)
    .replace(ISO, (raw) => at(Date.parse(raw), raw))
    .replace(COMPACT, (raw, y, mo, d, h, mi, s) => at(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), raw))
    .replace(EPOCH_MS, (raw) => at(Number(raw), raw))
    .replace(COMMS_ID, "the related message");
}

const WAIT_ABOUT = /^[\s\S]*?: waiting on ([\s\S]*)$/;
const WAIT_UNTIL = /^waiting until (\S+)/;

/**
 * One decision as a lead and the rest of its line. A wait is written by the hub as
 * `<target key>: waiting on <what>` and `waiting until <ISO time>`: the key and the ISO time mean
 * nothing to the operator, so the lead is the ticket (or "Wait") and the time is a clock time.
 */
export function decisionLine(
  d: FlightDecision,
  now: number,
  tz: string,
): { lead: string; rest: string } {
  if (d.kind === "wait") {
    const on = WAIT_ABOUT.exec(d.about)?.[1] ?? d.about;
    const until = WAIT_UNTIL.exec(d.decision)?.[1];
    const ms = until === undefined ? Number.NaN : Date.parse(until);
    const when = Number.isFinite(ms) ? ` · Waits until ${whenLabel(ms, now, tz)}` : "";
    return { lead: d.ref ?? "Wait", rest: `waiting on ${readableText(on, now, tz)}${when}` };
  }
  return { lead: readableText(d.about, now, tz), rest: readableText(d.decision, now, tz) };
}
