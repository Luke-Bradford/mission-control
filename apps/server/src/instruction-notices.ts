import { COMMS_MC, type InstructionMutation, seatDef } from "@mc/core";
import type { ChangeBus } from "./bus.ts";
import { sendComms } from "./comms.ts";
import type { CcConfig } from "./config.ts";
import { messageUnpausedSeat } from "./crew-pause.ts";
import type { Supervisor } from "./runtime/supervisor.ts";
import type { Store } from "./store.ts";

/** The note key prefix of a seat's failed focus import; hud.ts lists it as a hub stop. */
export const INSTRUCTION_FOCUS_NOTE_PREFIX = "instruction-focus";

interface NoticeDeps {
  config: CcConfig;
  store: Store;
  bus: ChangeBus;
  supervisor?: Pick<Supervisor, "message"> & Partial<Pick<Supervisor, "seatFacts">>;
  now?: () => number;
}
type Delivery = NonNullable<InstructionMutation["delivery"]>;
const keyOf = (id: number, action: string) => `${id}:${action}`;
const flushing = new WeakMap<Store, Promise<Map<string, Delivery>>>();
/** A stored unread inbox notice survives failed immediate notification. No duplicate Comms retry is needed. */
export function flushInstructionNotices(deps: NoticeDeps): Promise<Map<string, Delivery>> {
  const previous = flushing.get(deps.store);
  if (previous) return previous;
  const work = (async () => {
    const deliveries = new Map<string, Delivery>();
    const attempted = new Set<string>();
    const crew = () =>
      deps.config.crew?.sessions.flatMap((s) => s.seats.map((seat) => seat.id)) ?? [];
    // A later mutation can arrive while an earlier notification awaits its provider. Drain it too.
    for (;;) {
      const pending = deps.store.instructions
        .notices()
        .filter((n) => !attempted.has(keyOf(n.id, n.action)));
      if (pending.length === 0) break;
      for (const notice of pending) {
        const key = keyOf(notice.id, notice.action);
        attempted.add(key);
        deliveries.set(key, "pending");
        const seat = notice.entry.seatId;
        if (seat === null || !crew().includes(seat)) continue;
        const flight = deps.config.crew?.sessions
          .flatMap((s) => s.seats)
          .find((s) => seatDef(s).loop === "watch");
        if (notice.by === "flight" && !flight) continue;
        // the notice is the hub's record of a change; FLIGHT's own change is FLIGHT's
        const from = notice.by === "flight" ? flight!.id : COMMS_MC;
        try {
          const message = await sendComms(
            {
              store: deps.store,
              crew,
              knownSecrets: async () => [],
              now: deps.now,
              seatSender: false,
              senderKind: notice.by === "flight" ? "flight" : "hub",
            },
            from,
            {
              to: seat,
              text: `Instruction ${notice.id} ${notice.action}. The next turn carries the complete current instruction snapshot.`,
              label: "handoff",
            },
          );
          deps.store.instructions.noticeStored(notice.id, notice.action, message.id);
          deliveries.set(key, "inbox");
          const facts = deps.supervisor?.seatFacts?.(seat);
          if (deps.supervisor && facts?.inTurn === false) {
            await messageUnpausedSeat(deps.store, deps.supervisor, seat, "", {
              interrupt: false,
              questions: "none",
            });
            deliveries.set(key, "notified");
          }
        } catch {
          // Keep pending only if Comms storage failed. A notification error leaves a durable inbox.
          deliveries.set(key, deps.store.instructions.noticeDelivery(notice.id, notice.action));
        }
      }
    }
    return deliveries;
  })();
  flushing.set(deps.store, work);
  void work.finally(() => flushing.delete(deps.store));
  return work;
}
export async function announceInstruction(
  deps: NoticeDeps,
  result: InstructionMutation,
): Promise<InstructionMutation> {
  if (!result.changed) return result;
  deps.bus.emit("flight");
  deps.bus.emit("agents");
  deps.bus.emit("config");
  const deliveries = await flushInstructionNotices(deps);
  if (result.entry.seatId === null) return result;
  const action = result.entry.revokedAt === null ? "saved" : "revoked";
  const delivery =
    deliveries.get(keyOf(result.entry.id, action)) ??
    deps.store.instructions.noticeDelivery(result.entry.id, action);
  return { ...result, delivery };
}

/** Config-import warnings describe an active failure, so a successful retry clears only its own note. */
export function importInstructionFocus(
  deps: Pick<NoticeDeps, "config" | "store" | "bus" | "now"> & { log?: (text: string) => void },
): void {
  const now = deps.now ?? Date.now;
  const open = new Set(deps.store.notes().map((note) => note.key));
  let attentionChanged = false;
  for (const session of deps.config.crew?.sessions ?? [])
    for (const seat of session.seats) {
      const key = `${INSTRUCTION_FOCUS_NOTE_PREFIX}:${seat.id}`;
      try {
        deps.store.instructions.syncFocus(seat, now());
        if (open.has(key)) {
          deps.store.clearNote(key, now());
          attentionChanged = true;
        }
      } catch (error) {
        deps.log?.(
          `Could not import focus for ${seat.id}: ${error instanceof Error ? error.message : "instruction store unavailable"}`,
        );
        deps.store.raiseNote({
          key,
          kind: "blocked",
          runId: null,
          seatId: seat.id,
          repoId: session.repoId,
          text: "Configured focus could not be imported. Check instruction capacity and the saved focus before starting more work.",
          at: now(),
        });
        attentionChanged = true;
      }
    }
  if (attentionChanged) deps.bus.emit("attention");
}
