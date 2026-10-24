import type { CrewRow } from "@mc/core";
import { useState } from "react";
import { interruptSeat, seatError } from "../agent/seat.ts";
import type { NeedPart } from "../crew.ts";
import { openItem } from "../shell/overlays.ts";

const LABEL = {
  answer: "Answer",
  open: "Open",
  read: "Read",
  interrupt: "Interrupt",
  stop: "Stop the run",
} as const;

const CLASS = {
  answer: "sm primary",
  open: "sm",
  read: "sm",
  interrupt: "sm",
  stop: "sm warn",
} as const;

/**
 * The button a need-line part carries (Overview rows and the Agent banner): Answer, Open and Read open
 * the item's panel, Interrupt and Stop the run stop the seat's turn. A refusal shows beside it.
 */
export function NeedButton({ part, row }: { part: NeedPart; row: Pick<CrewRow, "id"> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = part.action;
  if (action === null) return null;
  const click = async () => {
    if (action === "answer" || action === "open" || action === "read") {
      openItem(part.key);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await interruptSeat(row);
    } catch (e) {
      setError(seatError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {" "}
      <button
        type="button"
        className={CLASS[action]}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          void click();
        }}
      >
        {LABEL[action]}
      </button>
      {error && (
        <span className="crit-t s" role="alert">
          {" "}
          {error}
        </span>
      )}
    </>
  );
}
