import { isUtf8 } from "node:buffer";
import { INSTRUCTION_PRECEDENCE, instructionSnapshot, seatInstructionBlock } from "@mc/core";
import type { CrewSeatConfig } from "../config.ts";
import type { PromptPiece } from "../prompt-cost.ts";
import type { Store } from "../store.ts";
import { readBaseEntry } from "./checkouts.ts";

export const DIRECTION_MAX_BYTES = 64 * 1024;
export class DirectionContextError extends Error {}
export interface DirectionContext {
  sha: string;
  text: string | null;
  restored: boolean;
}
/** The revision of the guidance the run's session was last sent in full. */
export const deliveredKey = (runId: string): string => `instruction.delivered:${runId}`;
/** Stored when a session may have lost its history: the next delivery sends everything. */
export const NO_DELIVERY = "";
export const directionKey = (runId: string): string => `instruction.direction:${runId}`;
export async function readDirectionContext(
  checkout: string,
  sha: string,
  restored = false,
): Promise<DirectionContext> {
  let entry: Awaited<ReturnType<typeof readBaseEntry>>;
  try {
    entry = await readBaseEntry(checkout, sha, "docs/direction.md");
  } catch (cause) {
    throw new DirectionContextError(
      "Could not verify FLIGHT direction. Repair the selected base Git objects before resuming.",
      { cause },
    );
  }
  if (!entry) return { sha, text: null, restored };
  if (
    !entry.body ||
    !["100644", "100755"].includes(entry.mode) ||
    entry.body.byteLength > DIRECTION_MAX_BYTES ||
    !isUtf8(entry.body)
  )
    throw new DirectionContextError(
      "FLIGHT direction is unsafe, invalid UTF-8 or above 64 KiB. Fix docs/direction.md on the selected base before resuming.",
    );
  return { sha, text: entry.body.toString("utf8"), restored };
}
export function directionContext(store: Store, runId: string): DirectionContext {
  const raw = store.getSetting(directionKey(runId));
  if (!raw)
    throw new DirectionContextError(
      "FLIGHT's verified direction context is missing. Resume the run to rebuild it from verified Git objects.",
    );
  let parsed: DirectionContext;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new DirectionContextError(
      "FLIGHT's retained direction context is invalid. Resume from a verified base.",
      { cause },
    );
  }
  if (
    !parsed ||
    !/^[0-9a-f]{40}$/.test(parsed.sha) ||
    (parsed.text !== null && typeof parsed.text !== "string") ||
    (typeof parsed.text === "string" && Buffer.byteLength(parsed.text) > DIRECTION_MAX_BYTES)
  )
    throw new DirectionContextError(
      "FLIGHT's retained direction context is invalid. Resume from a verified base.",
    );
  return parsed;
}
export function needsDirectionContext(store: Store, runId: string): boolean {
  try {
    directionContext(store, runId);
    return false;
  } catch (error) {
    if (error instanceof DirectionContextError) return true;
    throw error;
  }
}

export interface DeliveryEnvelope {
  text: string;
  pieces: PromptPiece[];
  revision: string;
}
/** Called inside the final delivery queue, never from a previously prepared wake digest. */
export function instructionEnvelope(
  store: Store,
  seat: CrewSeatConfig,
  runId: string,
  watch: boolean,
  text: string,
): DeliveryEnvelope {
  store.instructions.syncFocus(seat);
  const active = store.instructions.active(seat.id);
  const hasSeatHistory = store.instructions.hasTarget(seat.id);
  const seatBlock = hasSeatHistory ? seatInstructionBlock(active) : "";
  const revision = store.instructions.revision();
  if (!watch)
    return {
      text: seatBlock ? `${seatBlock}\n\n${text}` : text,
      pieces: seatBlock
        ? [{ section: "orders", bytes: Buffer.byteLength(`${seatBlock}\n\n`) }]
        : [],
      revision,
    };
  const direction = directionContext(store, runId);
  if (store.getSetting(deliveredKey(runId)) === revision) {
    // The session already holds this revision in full; say so rather than repeat it.
    const stub = `[Mission Control] Saved guidance unchanged (revision ${revision}, direction ${direction.sha}); the complete text was delivered earlier in this session.\n\n# Original message and working context\n`;
    return {
      text: stub + text,
      pieces: [{ section: "orders", bytes: Buffer.byteLength(stub) }],
      revision,
    };
  }
  const directionBlock = `# Verified repository direction (${direction.sha}${direction.restored ? "; rebuilt on resume" : ""})\n${direction.text ?? "No docs/direction.md exists at this verified base."}`;
  const ordersBlock = `# Active operator orders\n${instructionSnapshot(store.instructions.active(null)) || "No active operator orders."}`;
  const guidance = `[Mission Control] Current saved guidance.\n${INSTRUCTION_PRECEDENCE}\n\n${directionBlock}\n\n${ordersBlock}${seatBlock ? `\n\n${seatBlock}` : ""}\n\n# Original message and working context\n`;
  return {
    text: guidance + text,
    pieces: [
      { section: "rules", bytes: Buffer.byteLength(`${directionBlock}\n\n`) },
      {
        section: "orders",
        bytes: Buffer.byteLength(guidance) - Buffer.byteLength(`${directionBlock}\n\n`),
      },
    ],
    revision,
  };
}
