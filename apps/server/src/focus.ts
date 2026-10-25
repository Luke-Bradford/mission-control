import type { BoardItem } from "@mc/core";
import { z } from "zod";

/** FLIGHT translates natural language into lane/label selectors or stable ticket refs. */
const tokens = (focus: string): string[] => focus.trim().split(/[\s,]+/);
const selector =
  /^(?:lane:[A-Za-z0-9._-]+|label:[A-Za-z0-9:._-]+|[A-Za-z0-9][A-Za-z0-9._-]{0,39}#[1-9][0-9]{0,9})$/;
export const seatFocus = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (s) => tokens(s).every((t) => selector.test(t)),
    "use lane:name, label:name or repo#issue selectors",
  )
  .nullable();

export function matchesFocus(focus: string | null | undefined, card: BoardItem): boolean {
  if (focus == null) return true;
  if (!seatFocus.safeParse(focus).success) return false;
  const parts = tokens(focus);
  const refs = parts.filter((t) => t.includes("#"));
  return (
    (refs.length === 0 || refs.includes(`${card.repoId}#${card.issueNumber}`)) &&
    parts
      .filter((t) => !t.includes("#"))
      .every((t) => card.labels.includes(t.startsWith("label:") ? t.slice(6) : t))
  );
}
