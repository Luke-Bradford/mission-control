/**
 * Text typed and not yet sent, by item key, so switching items on Needs you does not lose it. It
 * lives in the module (not a component) and is cleared when the message is sent.
 */
export type DraftKind = "answer" | "ask";

const drafts = new Map<string, string>();
const id = (kind: DraftKind, key: string): string => `${kind}\u0000${key}`;

export const getDraft = (kind: DraftKind, key: string | null): string =>
  key === null ? "" : (drafts.get(id(kind, key)) ?? "");

export function setDraft(kind: DraftKind, key: string, text: string): void {
  if (text === "") drafts.delete(id(kind, key));
  else drafts.set(id(kind, key), text);
}

export const clearDraft = (kind: DraftKind, key: string): void => {
  drafts.delete(id(kind, key));
};
