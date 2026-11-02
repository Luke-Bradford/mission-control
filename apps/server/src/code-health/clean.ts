import { cleanText } from "../clean.ts";

/** Inert, bounded evidence text for both HTTP and the read-only tool response. */
export function cleanCodeHealth(value: unknown, knownSecrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of knownSecrets) {
      if (secret.length >= 16) text = text.split(secret).join("[redacted]");
    }
    return cleanText(text, 2000);
  }
  if (Array.isArray(value)) return value.map((item) => cleanCodeHealth(item, knownSecrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cleanCodeHealth(item, knownSecrets)]),
    );
  return value;
}
