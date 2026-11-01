/** Shared vocabulary and data shapes; independent of the domain algorithms. */

export const STAGES = ["Needs detail", "Ready"] as const;

export type Stage = (typeof STAGES)[number];

export const OWNERS = ["PM", "CTO", "Agent", "Operator"] as const;

export type Owner = (typeof OWNERS)[number];
