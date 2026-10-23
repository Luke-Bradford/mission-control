export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Intl formatters are costly to build; one per (options, zone). */
const formatters = new Map<string, Intl.DateTimeFormat>();
export function zoneFormatter(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${tz}|${JSON.stringify(opts)}`;
  let f = formatters.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts });
    formatters.set(id, f);
  }
  return f;
}
