import { COMMS_CAPCOM, type InstructionMutation, seatDef } from "@mc/core";
import type { ChangeBus } from "./bus.ts";
import { sendComms } from "./comms.ts";
import type { CcConfig } from "./config.ts";
import type { Supervisor } from "./runtime/supervisor.ts";
import type { Store } from "./store.ts";

interface NoticeDeps {
  config: CcConfig;
  store: Store;
  bus: ChangeBus;
  supervisor?: Pick<Supervisor, "message"> & Partial<Pick<Supervisor, "seatFacts">>;
  now?: () => number;
}
const flushing = new WeakMap<Store, Promise<"inbox" | "notified" | "pending">>();
/** Mutation receipts survive notification errors. Comms is stored before any provider notification. */
export function flushInstructionNotices(
  deps: NoticeDeps,
): Promise<"inbox" | "notified" | "pending"> {
  const previous = flushing.get(deps.store);
  if (previous) return previous;
  const work = (async () => {
    let delivery: "inbox" | "notified" | "pending" = "inbox";
    const crew = () =>
      deps.config.crew?.sessions.flatMap((s) => s.seats.map((seat) => seat.id)) ?? [];
    for (const notice of deps.store.instructions.notices()) {
      const seat = notice.entry.seatId;
      if (seat === null || !crew().includes(seat)) {
        delivery = "pending";
        continue;
      }
      const flight = deps.config.crew?.sessions
        .flatMap((s) => s.seats)
        .find((s) => seatDef(s).loop === "watch");
      const from = notice.by === "flight" ? (flight?.id ?? COMMS_CAPCOM) : COMMS_CAPCOM;
      try {
        const message = await sendComms(
          {
            store: deps.store,
            crew,
            knownSecrets: async () => [],
            now: deps.now,
            seatSender: false,
          },
          from,
          {
            to: seat,
            text: `Instruction ${notice.id} ${notice.action}. The next turn carries the complete current instruction snapshot.`,
            label: "handoff",
          },
        );
        deps.store.instructions.noticeStored(notice.id, notice.action, message.id);
        const facts = deps.supervisor?.seatFacts?.(seat);
        if (deps.supervisor && facts?.inTurn === false) {
          await deps.supervisor.message(seat, "", { interrupt: false, questions: "none" });
          delivery = "notified";
        }
      } catch {
        delivery = "pending";
      }
    }
    return delivery;
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
  const delivery = await flushInstructionNotices(deps);
  return result.entry.seatId === null ? result : { ...result, delivery };
}
