import type { CrewPause, StandingInstruction, StandingInstructionList } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../../api.ts";
import { useNow, useTz } from "../../clock.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../../data.ts";
import { rel } from "../../fmt.ts";
import { Pending } from "../Pending.tsx";

/** The hub stores no end time for an order or a pause: both run until someone ends them. */
export const ENDS_UNSET = "Ends: not set, runs until you end it";

/** One order in force, as the panel shows it. */
interface OrderRow {
  key: string;
  /** What the order says. */
  text: string;
  by: string;
  at: number;
  endLabel: string;
  /** Ends the order through the hub's existing route. */
  end: () => Promise<unknown>;
}

const fromInstruction = (o: StandingInstruction): OrderRow => ({
  key: `order:${o.id}`,
  text: o.kind === "text" ? o.text : (o.focus ?? ""),
  by: o.by,
  at: o.at,
  endLabel: "End order",
  end: () => apiPost(ACTIONS.revokeInstruction(null, o.id), {}),
});

const fromPause = (p: CrewPause): OrderRow => ({
  key: "pause",
  text: `Crew paused (${p.seats === "all" ? "all seats" : p.seats.join(", ")}): ${p.reason}`,
  by: p.by,
  at: p.at,
  endLabel: "Resume crew",
  end: () => apiPost(ACTIONS.crewPause, { seats: null }),
});

function OrderLine({ row, now, tz }: { row: OrderRow; now: number; tz: string | null }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await row.end();
      hub.refetch(RESOURCES.flightOrders.path);
      hub.refetch(RESOURCES.crewPause.path);
      setConfirming(false);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li>
      <span className="fp-w fp-one" title={row.text}>
        <b>{row.text}</b>{" "}
        <span>
          Set by {row.by} · {tz === null ? "time not known" : rel(row.at, now, tz)} · {ENDS_UNSET}
        </span>
      </span>
      {failure && (
        <span role="alert" className="fp-err">
          Not ended: {failure}
        </span>
      )}
      {confirming ? (
        <span className="fp-end">
          <button type="button" className="sm" disabled={busy} onClick={() => void run()}>
            {busy ? "Ending…" : `Confirm end: ${row.endLabel}`}
          </button>
          <button type="button" className="sm" disabled={busy} onClick={() => setConfirming(false)}>
            Keep
          </button>
        </span>
      ) : (
        <button type="button" className="sm fp-end" onClick={() => setConfirming(true)}>
          {row.endLabel}
        </button>
      )}
    </li>
  );
}

/**
 * What the operator has ordered that is still in force: each standing order and the crew pause, who
 * set it, when, when it ends and one action to end it. Nothing is hidden: an order nobody has
 * ended keeps showing, so a held board is never a mystery.
 */
export function StandingOrders() {
  const orders = useResource<StandingInstructionList>(RESOURCES.flightOrders);
  const pause = useResource<CrewPause | null>(RESOURCES.crewPause);
  const now = useNow();
  const tz = useTz();
  const rows: OrderRow[] = [
    ...(pause.data ? [fromPause(pause.data)] : []),
    ...(orders.data?.active ?? []).map(fromInstruction),
  ];
  const loading = orders.data === undefined || pause.data === undefined;
  return (
    <section className="fp-panel fp-orders" id="ordersP" aria-labelledby="ordersH">
      <h2 className="fp-head" id="ordersH">
        Standing orders
        <span className="fp-sub">
          {loading
            ? "loading"
            : rows.length === 0
              ? "No orders in force"
              : `${rows.length} in force`}
        </span>
      </h2>
      {orders.data === undefined && orders.error ? (
        <Pending what="standing orders" error={orders.error} resource={RESOURCES.flightOrders} />
      ) : rows.length > 0 ? (
        <ul className="fp-lines fp-orderlist" id="orders">
          {rows.map((row) => (
            <OrderLine key={row.key} row={row} now={now} tz={tz} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
