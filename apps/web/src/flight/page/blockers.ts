import {
  type AttentionItem,
  type AttentionOwner,
  type FlightBlocked,
  type FlightView,
  isOperatorItem,
} from "@mc/core";
import { needText } from "../../comms/needText.ts";
import type { FlightRun } from "../Situation.tsx";

export type OwnerTone = "operator" | "ci" | "plain";

/** One thing that holds FLIGHT up, who owns it and what FLIGHT does meanwhile. */
export interface Blocker {
  key: string;
  what: string;
  detail: string;
  /** Who has to act, in words ("Operator", "CI", "Hub", a seat or ticket). */
  owner: string;
  tone: OwnerTone;
  /** How long it has waited in ms; null when the hub does not say. */
  waitedMs: number | null;
  doing: string;
}

const MIN_MS = 60_000;

/** Who owns an attention item that FLIGHT does not own. */
function ownerOf(item: AttentionItem): { owner: string; tone: OwnerTone } {
  if (item.alert) return { owner: "Hub", tone: "plain" };
  const o: AttentionOwner = item.owner ?? "operator";
  if (o === "operator") return { owner: "Operator", tone: "operator" };
  if (o === "controller") return { owner: "Controller", tone: "plain" };
  if (o === "loop") return { owner: item.agentId ?? "Loop", tone: "plain" };
  return { owner: "Work lane", tone: "plain" };
}

function itemDoing(item: AttentionItem): string {
  if (item.flightTriage === "waiting") return "Has not triaged it yet.";
  if (item.flightTriage === "missed") return "Missed it; it is back with the owner.";
  if (item.flightTriage === "down") return "Cannot triage it while FLIGHT is stopped.";
  if (item.brief?.assessment) return item.brief.assessment;
  return isOperatorItem(item)
    ? "Asked in Needs you. Carrying on with work that does not depend on it."
    : "Watching. It clears when the owner acts.";
}

/** A ticket waiting on other work is owned by CI when the wait names CI, else by the ticket it waits on. */
function ticketOwner(b: FlightBlocked): { owner: string; tone: OwnerTone } {
  if (b.waitsOn.some((w) => /\bCI\b/.test(w))) return { owner: "CI", tone: "ci" };
  return { owner: "Other ticket", tone: "plain" };
}

/**
 * The blockers, longest wait first: asks that others own (the operator's above all), tickets
 * waiting on unmerged work, and FLIGHT itself being stopped or held. A wait the hub does not
 * date sorts last.
 */
export function buildBlockers(
  attention: readonly AttentionItem[] | undefined,
  flight: FlightView | undefined,
  run: FlightRun,
  now: number,
): Blocker[] {
  const rows: Blocker[] = [];
  if (run.kind === "down" || run.kind === "held") {
    rows.push({
      key: "flight-run",
      what: run.kind === "down" ? "FLIGHT is stopped" : "FLIGHT is held",
      detail: run.why,
      owner: "Operator",
      tone: "operator",
      waitedMs: null,
      doing:
        run.kind === "down"
          ? "Nothing runs until FLIGHT is started; seats keep working on their tickets."
          : "Waiting for the hold to lift; seats keep working on their tickets.",
    });
  }
  for (const item of attention ?? []) {
    if ((item.owner ?? "operator") === "flight") continue;
    const { owner, tone } = ownerOf(item);
    rows.push({
      key: `attention:${item.key}`,
      what: needText(item, now),
      detail: item.ticket ?? "",
      owner,
      tone,
      waitedMs: item.at > 0 ? Math.max(0, now - item.at) : null,
      doing: itemDoing(item),
    });
  }
  for (const b of flight?.blocked ?? []) {
    const { owner, tone } = ticketOwner(b);
    rows.push({
      key: `ticket:${b.ref}`,
      what: `${b.ref} ${b.title}`,
      detail: `Waits on ${b.waitsOn.join(", ")}`,
      owner,
      tone,
      waitedMs: b.waitedMin * MIN_MS,
      doing: b.waitsOn[0] ? `Watching. It moves once ${b.waitsOn[0]} clears.` : "Watching.",
    });
  }
  return rows.sort(
    (a, b) => (b.waitedMs ?? -1) - (a.waitedMs ?? -1) || a.what.localeCompare(b.what),
  );
}
