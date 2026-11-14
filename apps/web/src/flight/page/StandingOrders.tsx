import type { CrewPause, StandingInstruction, StandingInstructionList } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../../api.ts";
import { useNow, useTz } from "../../clock.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../../data.ts";
import { rel } from "../../fmt.ts";
import { Pending } from "../Pending.tsx";

/** The hub stores no end time for an order or a pause: both run until someone ends them. */
export const ENDS_UNSET = "Ends: not set";
const ENDS_TITLE = "The hub stores no end time: the order runs until someone ends it.";

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

/** Ends an order through its route; asks first, and says why when it fails. */
function EndControl({ row }: { row: OrderRow }) {
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
    <>
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
    </>
  );
}

function Meta({ row, now, tz }: { row: OrderRow; now: number; tz: string | null }) {
  return (
    <span className="fp-meta" title={ENDS_TITLE}>
      Set by {row.by} · {tz === null ? "time not known" : rel(row.at, now, tz)} · {ENDS_UNSET}
    </span>
  );
}

/** Longer than this, the order text gets a Show all button. */
const LONG_ORDER = 120;

/** One order in the full list: the text clamped (with a button for all of it), then its meta that never truncates. */
function OrderLine({ row, now, tz }: { row: OrderRow; now: number; tz: string | null }) {
  const [all, setAll] = useState(false);
  return (
    <li>
      <span className="fp-w fp-ocol">
        <b className={all ? undefined : "fp-clamp"} title={row.text}>
          {row.text}
        </b>
        <Meta row={row} now={now} tz={tz} />
        {row.text.length > LONG_ORDER && (
          <button
            type="button"
            className="sm fp-showall"
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all ? "Show less" : "Show all"}
          </button>
        )}
      </span>
      <EndControl row={row} />
    </li>
  );
}

/**
 * What the operator has ordered that is still in force: each standing order and the crew pause, who
 * set it, when, when it ends and one action to end it. A one-line strip under the status band
 * always shows the first order whole in meta and end; "Show all" opens every order over the page
 * without moving it. Nothing is hidden: an order nobody has ended keeps showing, so a held board is
 * never a mystery.
 */
export function StandingOrders() {
  const orders = useResource<StandingInstructionList>(RESOURCES.flightOrders);
  const pause = useResource<CrewPause | null>(RESOURCES.crewPause);
  const now = useNow();
  const tz = useTz();
  const [open, setOpen] = useState(false);
  const rows: OrderRow[] = [
    ...(pause.data ? [fromPause(pause.data)] : []),
    ...(orders.data?.active ?? []).map(fromInstruction),
  ];
  const first = rows[0];
  const loading = orders.data === undefined || pause.data === undefined;
  return (
    <section className="fp-panel fp-orders" id="ordersP" aria-labelledby="ordersH">
      <div className="fp-ostrip">
        <h2 className="fp-ohead" id="ordersH">
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
        ) : first ? (
          <>
            <b className="fp-one fp-ofirst" title={first.text}>
              {first.text}
            </b>
            <Meta row={first} now={now} tz={tz} />
            <EndControl row={first} />
            <button
              type="button"
              className="sm"
              aria-expanded={open}
              aria-controls="orders"
              onClick={() => setOpen(!open)}
            >
              {open ? "Hide list" : `Show all (${rows.length})`}
            </button>
          </>
        ) : null}
      </div>
      {open && first && (
        <ul className="fp-lines fp-orderlist" id="orders">
          {rows.map((row) => (
            <OrderLine key={row.key} row={row} now={now} tz={tz} />
          ))}
        </ul>
      )}
    </section>
  );
}
