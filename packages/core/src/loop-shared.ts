/** Shared data and helpers; independent of domain control flow. */

/** With no reset time, a rate-limited seat is tried once per this long. */
export const RATE_LIMIT_RETRY_MS = 3_600_000;

/** Fills `{name}` placeholders of a loop text; an unknown name is left as written. */
export const fillLoopText = (template: string, vars: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
