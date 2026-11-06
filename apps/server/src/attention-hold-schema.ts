import { BRIEF_KEY_MAX } from "@mc/core";
import { z } from "zod";

const PR_REF = /^[^#\s]+#[1-9]\d*$/;

export const AttentionHoldInput = z
  .object({
    reason: z.string().trim().min(1).max(1000),
    condition: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("manual") }).strict(),
      z.object({ kind: z.literal("crew") }).strict(),
      z
        .object({
          kind: z.literal("date"),
          at: z.number().int().min(0).max(8640000000000000),
        })
        .strict(),
      z
        .object({
          kind: z.literal("ticket"),
          ticket: z.string().regex(PR_REF),
        })
        .strict(),
      z
        .object({
          kind: z.literal("ci"),
          pr: z.string().regex(PR_REF),
          state: z.enum(["passing", "failing"]),
        })
        .strict(),
      z.object({ kind: z.literal("item"), key: z.string().min(1).max(BRIEF_KEY_MAX) }).strict(),
    ]),
  })
  .strict();
