/**
 * A controller's approval for FLIGHT to go past one of the repo's rules (#1214). Only the operator
 * token can record one (`POST /api/flight/approvals`); FLIGHT's `mc operator` never reaches that
 * route. A grant covers one scope until its `until`. A guard approval is used up by the call it lets
 * through; a merge-floor approval is bound to one PR head and stays until it expires.
 */
import { randomUUID } from "node:crypto";
import type { FlightApprovalRule } from "@mc/core";
import type { Store } from "./store.ts";

export const FLIGHT_APPROVALS_SETTING = "flight.approvals";
/** The longest an approval may be time-boxed. */
export const FLIGHT_APPROVAL_MAX_MS = 7 * 24 * 60 * 60_000;
/** Grants kept: older used or expired ones are dropped first. */
const KEPT = 200;

export interface FlightApproval {
  id: string;
  rule: FlightApprovalRule;
  scope: string;
  at: number;
  until: number;
  reason: string;
  usedAt: number | null;
}

function read(store: Store): FlightApproval[] {
  try {
    const parsed: unknown = JSON.parse(store.getSetting(FLIGHT_APPROVALS_SETTING) ?? "[]");
    return Array.isArray(parsed) ? (parsed as FlightApproval[]) : [];
  } catch {
    return [];
  }
}

/** Records a grant; the approval stored. */
export function grantApproval(
  store: Store,
  grant: Pick<FlightApproval, "rule" | "scope" | "until" | "reason">,
  at: number,
): FlightApproval {
  const approval: FlightApproval = { id: randomUUID(), ...grant, at, usedAt: null };
  const all = [...read(store), approval];
  store.setSetting(FLIGHT_APPROVALS_SETTING, JSON.stringify(all.slice(-KEPT)));
  return approval;
}

/** The open grant (not used, not expired) for this rule and exact scope, if any. */
export function findApproval(
  store: Store,
  rule: FlightApprovalRule,
  scope: string,
  at: number,
): FlightApproval | undefined {
  return read(store).find(
    (a) => a.rule === rule && a.scope === scope && a.usedAt === null && a.until > at,
  );
}

/** Marks a grant used, so it lets no second call through. */
export function useApproval(store: Store, id: string, at: number): void {
  store.setSetting(
    FLIGHT_APPROVALS_SETTING,
    JSON.stringify(read(store).map((a) => (a.id === id ? { ...a, usedAt: at } : a))),
  );
}

/** The scope of a PR-merge approval: the PR and the head it was approved at. */
export const mergeFloorScope = (pr: number, headSha: string): string => `pr:${pr}@${headSha}`;

/**
 * The open `merge-floor` grant for this PR's head. The grant names the head by at least its first
 * seven characters, so a controller need not paste forty.
 */
export function mergeFloorApproval(
  store: Store,
  pr: number,
  headSha: string | null | undefined,
  at: number,
): FlightApproval | undefined {
  if (!headSha) return undefined;
  const prefix = `pr:${pr}@`;
  return read(store).find((a) => {
    if (a.rule !== "merge-floor" || a.usedAt !== null || a.until <= at) return false;
    if (!a.scope.startsWith(prefix)) return false;
    const sha = a.scope.slice(prefix.length);
    return sha.length >= 7 && headSha.startsWith(sha);
  });
}
