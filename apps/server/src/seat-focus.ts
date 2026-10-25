import { type CcConfig, seatInput } from "./config.ts";
import { ConfigWriteError, setSessionSeats } from "./config-write.ts";
import type { CrewReloader } from "./crew-apply.ts";

/** Uses the session editor's optimistic check and reload, including its busy-seat deferral. */
export async function setSeatFocus(
  config: CcConfig,
  path: string,
  reloader: Pick<CrewReloader, "reload">,
  seatId: string,
  focus: string | null,
  at: number,
) {
  const session = config.crew?.sessions.find((s) => s.seats.some((seat) => seat.id === seatId));
  if (!session) throw new ConfigWriteError("missing", "Seat unavailable.");
  const base = session.seats.map(seatInput);
  await setSessionSeats(
    path,
    session.id,
    base,
    base.map((s) => (s.id === seatId ? { ...s, focus } : s)),
    at,
  );
  const changes = await reloader.reload();
  return { focus, changes };
}
