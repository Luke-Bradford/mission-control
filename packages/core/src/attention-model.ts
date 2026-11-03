export type AttentionHoldCondition =
  | { readonly kind: "date"; readonly at: number }
  | { readonly kind: "ticket"; readonly ticket: string }
  | { readonly kind: "crew" }
  | { readonly kind: "manual" };

/** Extra conditions accepted from FLIGHT's existing explicit wait flow. */
export type AttentionWaitCondition =
  | { readonly kind: "ci"; readonly pr: string; readonly state: "passing" | "failing" }
  | { readonly kind: "item"; readonly key: string };

export interface AttentionHold {
  reason: string;
  condition: AttentionHoldCondition | AttentionWaitCondition;
  by: string;
  at: number;
  releasedAt?: number;
}
