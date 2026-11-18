/**
 * The headings of each role's prompt file (`roles/<CALLSIGN>.md`), listed by the Read prompt
 * drawer. `test/RolesGuards.test.tsx` checks them against the files, so a changed prompt fails
 * there until this list follows.
 */
export const ROLE_HEADINGS: Readonly<Record<string, readonly string[]>> = {
  FAO: ["What the plan holds", "How you work", "What you may not do"],
  FLIGHT: [
    "What this is for",
    "What the operator sees",
    "Each wake",
    "How to unblock",
    "How to pass things on",
    "Orders and records",
    "The floor",
  ],
  GUIDO: ["How you work", "Coordination", "What you may not do"],
  INCO: ["How you work", "Coordination", "What you may not do"],
  RETRO: ["What you may do", "How you review", "Try to break it", "What you may not do"],
};
