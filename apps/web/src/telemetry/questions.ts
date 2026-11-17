import type { AttentionItem } from "@mc/core";
import { needsYouItems } from "../attention.ts";
import { RESOURCES, useResource } from "../data.ts";
import { isAlert } from "../needs/needsView.ts";

/** Open questions waiting on the operator: Needs you's items that are not the hub's alerts. */
export const openQuestions = (attention: readonly AttentionItem[]): number =>
  needsYouItems(attention).filter((i) => !isAlert(i)).length;

/** The open question count; undefined until the Needs you data has loaded. */
export function useOpenQuestions(): number | undefined {
  const attention = useResource<AttentionItem[]>(RESOURCES.attention).data;
  return attention === undefined ? undefined : openQuestions(attention);
}
