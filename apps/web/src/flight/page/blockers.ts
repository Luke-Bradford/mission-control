import { type AttentionItem, type AttentionOwner, type FlightView, isOperatorItem } from "@mc/core";
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
  /** The owner's full value when the tag is a short form of it (`#1572` for `repo#1572`). */
  ownerTitle?: string;
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

/**
 * Who has to act on a ticket's first open wait, read from the words the hub wrote for it
 * (`prStageText` and the wait reader in core): CI for a PR in or failing CI, its reviewer for one in
 * review, the merge step for one ready to merge, its author for a draft, the operator for work that
 * closed unmerged, the hub for a PR it has not read. A wait that is only a ticket reference names
 * no owner, so the reference itself is shown, not a guess at a person.
 */
export function waitOwner(
  wait: string | undefined,
  /** The blocked ticket (`repo#n`): a wait in its own repo drops the repo from the owner tag. */
  ticket?: string,
): { owner: string; tone: OwnerTone } {
  if (wait === undefined) return { owner: "Not recorded", tone: "plain" };
  if (/failing CI|in CI\b/.test(wait)) return { owner: "CI", tone: "ci" };
  if (/in review/.test(wait)) return { owner: "Reviewer", tone: "plain" };
  if (/ready to merge/.test(wait)) return { owner: "Merge step", tone: "plain" };
  if (/is a draft/.test(wait)) return { owner: "PR author", tone: "plain" };
  if (/closed without merging/.test(wait)) return { owner: "Operator", tone: "operator" };
  if (/not read yet/.test(wait)) return { owner: "Hub", tone: "plain" };
  const repo = ticket?.split("#")[0];
  const own = repo !== undefined && repo !== "" && wait.startsWith(`${repo}#`);
  return { owner: own ? wait.slice(repo.length) : wait, tone: "plain" };
}

/**
 * The blockers, longest wait first: asks that others own (the operator's above all), tickets
 * waiting on unmerged work, and FLIGHT itself when stopped or held (aged from its last wake; with
 * none recorded, its wait is unknown and it sorts after every dated wait).
 */
export function buildBlockers(
  attention: readonly AttentionItem[] | undefined,
  flight: FlightView | undefined,
  run: FlightRun,
  now: number,
): Blocker[] {
  const rows: Blocker[] = [];
  if (run.kind === "down" || run.kind === "held") {
    // The hub does not say when FLIGHT stopped; the time since its last wake is the nearest real age.
    const lastWake = flight?.wake?.lastWakeAt ?? null;
    rows.push({
      key: "flight-run",
      what: run.kind === "down" ? "FLIGHT is stopped" : "FLIGHT is held",
      detail: lastWake === null ? run.why : `${run.why} · counted from its last wake`,
      owner: "Operator",
      tone: "operator",
      waitedMs: lastWake === null ? null : Math.max(0, now - lastWake),
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
    const { owner, tone } = waitOwner(b.waitsOn[0], b.ref);
    rows.push({
      key: `ticket:${b.ref}`,
      ...(owner !== b.waitsOn[0] && /^[^\s(]+$/.test(b.waitsOn[0] ?? "")
        ? { ownerTitle: b.waitsOn[0] }
        : {}),
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
