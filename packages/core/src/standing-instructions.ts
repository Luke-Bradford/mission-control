/** Operator orders and per-seat guidance. Accepted entries are never silently shortened. */
export const INSTRUCTION_TEXT_MAX = 4000;
export const INSTRUCTION_ACTIVE_MAX = 64;
export const INSTRUCTION_BYTES_MAX = 64 * 1024;
export type InstructionAuthor = "operator" | "flight";
export type StandingInstructionInput =
  | { kind: "text"; text: string; replacesId?: number }
  | { kind: "focus"; focus: string | null; replacesId?: number };
interface InstructionRecord {
  id: number;
  at: number;
  revokedAt: number | null;
  source: "saved" | "legacy-config";
}
export type StandingInstruction = InstructionRecord &
  (
    | { seatId: null; by: "operator"; kind: "text"; text: string }
    | ({ seatId: string; by: InstructionAuthor } & (
        | { kind: "text"; text: string }
        | { kind: "focus"; focus: string | null }
      ))
  );
export interface StandingInstructionList {
  active: StandingInstruction[];
  history: StandingInstruction[];
  nextCursor: number | null;
}
export interface SeatInstructionList extends StandingInstructionList {
  effectiveFocus: string | null;
  focusInstructionId: number | null;
}
/** The page-shaped active instruction index; detailed history is read for one selected seat. */
export interface SeatInstructionIndex {
  seats: Array<
    Pick<SeatInstructionList, "active" | "effectiveFocus" | "focusInstructionId"> & {
      seatId: string;
    }
  >;
}
export type FocusInstructionView = Pick<
  SeatInstructionList,
  "effectiveFocus" | "focusInstructionId"
> & { focus: string | null };
export interface InstructionMutation {
  entry: StandingInstruction;
  changed: boolean;
  effectiveFocus?: string | null;
  focusInstructionId?: number | null;
  delivery?: "inbox" | "notified" | "pending";
}
export const INSTRUCTION_PRECEDENCE =
  "Operator orders outrank memory and seat instructions. Operator seat instructions outrank FLIGHT seat instructions. Repository rules, hard-rule approvals, budgets and safety floors remain binding. Preserve conflicting instructions and ask through the existing operator brief when their intended precedence is unclear.";
export function instructionSnapshot(entries: readonly StandingInstruction[]): string {
  return entries
    .slice()
    .sort((a, b) => a.at - b.at || a.id - b.id)
    .map((entry) => JSON.stringify(entry))
    .join("\n");
}
export function seatInstructionBlock(entries: readonly StandingInstruction[]): string {
  return `# Current seat instructions\n${INSTRUCTION_PRECEDENCE}\nThis complete current snapshot supersedes earlier seat-instruction snapshots. IDs absent here are revoked or replaced.\n${instructionSnapshot(entries) || "No active seat instructions."}`;
}
