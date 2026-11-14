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

/** The work a ticket waits on at the root of its chain, or its first wait's ticket with no chain. */
function rootOf(b: FlightBlocked): string {
  if (b.chain.length > 1) return b.chain[b.chain.length - 1] as string;
  return (b.waitsOn[0] ?? b.ref).split(" (")[0] as string;
}

/** Tickets that wait on the same root work are one blocker, not one per link of the chain. */
function blockedGroups(
  blocked: readonly FlightBlocked[],
): { root: string; members: FlightBlocked[] }[] {
  const groups = new Map<string, FlightBlocked[]>();
  for (const b of blocked) {
    const root = rootOf(b);
    groups.set(root, [...(groups.get(root) ?? []), b]);
  }
  return [...groups].map(([root, members]) => ({ root, members }));
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
  for (const group of blockedGroups(flight?.blocked ?? [])) {
    // The member nearest the root: its wait is the thing that, once it clears, frees the chain.
    const near = group.members.reduce((a, b) => (b.chain.length < a.chain.length ? b : a));
    const first = near.waitsOn[0];
    const { owner, tone } = waitOwner(first, near.ref);
    const freed = near.waitsOn.length > 0 ? `Frees when ${near.waitsOn.join(" and ")} clears.` : "";
    const one = group.members.length === 1;
    rows.push({
      key: one ? `ticket:${near.ref}` : `chain:${group.root}`,
      ...(owner !== first && /^[^\s(]+$/.test(first ?? "") ? { ownerTitle: first } : {}),
      what: one
        ? `${near.ref} ${near.title}`
        : `${group.members.length} tickets wait on ${group.root}`,
      detail: one ? freed : [freed, group.members.map((m) => m.ref).join(", ")].join(" "),
      owner,
      tone,
      waitedMs: Math.max(...group.members.map((m) => m.waitedMin)) * MIN_MS,
      doing: first
        ? `Nothing to do for ${one ? "it" : "them"} until ${first} clears; ${one ? "it moves" : "they move"} on their own.`
        : "Watching.",
    });
  }
  return rows.sort(
    (a, b) => (b.waitedMs ?? -1) - (a.waitedMs ?? -1) || a.what.localeCompare(b.what),
  );
}
