import { createHash } from "node:crypto";
export const recommendationHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
