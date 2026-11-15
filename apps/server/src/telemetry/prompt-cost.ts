import {
  estimateTokens,
  type FlightWake,
  PROMPT_SECTIONS,
  type PromptSection,
  type PromptSectionCost,
} from "@mc/core";

/** Bytes of one named part of a prompt. */
export interface PromptPiece {
  section: PromptSection;
  bytes: number;
}

export const textBytes = (text: string): number => Buffer.byteLength(text, "utf8");

const costOf = (section: PromptSection, bytes: number): PromptSectionCost => ({
  section,
  bytes,
  tokens: estimateTokens(bytes),
});

const inOrder = (a: PromptSectionCost, b: PromptSectionCost): number =>
  PROMPT_SECTIONS.indexOf(a.section) - PROMPT_SECTIONS.indexOf(b.section);

/**
 * The prompt's bytes by section: each piece takes its own, the remainder goes to `rest`, so the
 * parts always add up to the whole. Pieces over the whole are cut in order; empty sections drop.
 */
export function promptSections(
  whole: string,
  pieces: readonly PromptPiece[],
  rest: PromptSection,
): PromptSectionCost[] {
  let left = textBytes(whole);
  const bytes = new Map<PromptSection, number>();
  for (const p of pieces) {
    const take = Math.min(Math.max(0, p.bytes), left);
    left -= take;
    bytes.set(p.section, (bytes.get(p.section) ?? 0) + take);
  }
  bytes.set(rest, (bytes.get(rest) ?? 0) + left);
  return [...bytes]
    .filter(([, n]) => n > 0)
    .map(([section, n]) => costOf(section, n))
    .sort(inOrder);
}

/** Section lists summed by section, in the order a page lists them. */
export function mergeSections(...lists: readonly PromptSectionCost[][]): PromptSectionCost[] {
  const bytes = new Map<PromptSection, number>();
  for (const s of lists.flat()) bytes.set(s.section, (bytes.get(s.section) ?? 0) + s.bytes);
  return [...bytes].map(([section, n]) => costOf(section, n)).sort(inOrder);
}

/** The ticket's body plus the note that it was cut. */
export function ticketPiece(body: string, note: string | null): PromptPiece {
  return { section: "ticket", bytes: textBytes(body) + (note === null ? 0 : textBytes(note)) };
}

/** A wake line's digest JSON, split into FLIGHT's lessons (its memory) and the rest. */
export function wakePieces(digest: FlightWake): PromptPiece[] {
  const memory = (digest as { memory?: unknown }).memory;
  const lessons = memory === undefined ? 0 : textBytes(`"memory":${JSON.stringify(memory)},`);
  const whole = textBytes(JSON.stringify(digest));
  return [
    { section: "lessons", bytes: Math.min(lessons, whole) },
    { section: "digest", bytes: whole - Math.min(lessons, whole) },
  ];
}

/** Bytes of a tool result's content as the model reads it. */
export function toolResultBytes(content: unknown): number {
  if (typeof content === "string") return textBytes(content);
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    const text = (block as { type?: unknown; text?: unknown } | null)?.text;
    n += textBytes(typeof text === "string" ? text : (JSON.stringify(block) ?? ""));
  }
  return n;
}
