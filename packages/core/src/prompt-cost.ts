/** A prompt's parts, in the order a page lists them. */
export const PROMPT_SECTIONS = [
  "role",
  "rules",
  "orders",
  "lessons",
  "ticket",
  "digest",
  "tool_results",
] as const;
export type PromptSection = (typeof PROMPT_SECTIONS)[number];
/** The estimate's rate: about 4 bytes of English text per token. */
export const PROMPT_BYTES_PER_TOKEN = 4;
export const estimateTokens = (bytes: number): number => Math.round(bytes / PROMPT_BYTES_PER_TOKEN);
export interface PromptSectionCost {
  section: PromptSection;
  bytes: number;
  tokens: number;
}
/** One prompt a run was sent: wake 0 is the start; FLIGHT's wake n is wakeKey(runId, n). */
export interface PromptWakeCost {
  runId: string;
  wake: number;
  at: number;
  sections: PromptSectionCost[];
}
