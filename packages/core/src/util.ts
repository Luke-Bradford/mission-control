export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The locale dates and numbers use unless the operator sets `operator.locale`. */
export const DEFAULT_LOCALE = "en-GB";

/** Intl formatters are costly to build; one per (options, zone, locale). */
const formatters = new Map<string, Intl.DateTimeFormat>();
export function zoneFormatter(
  tz: string,
  opts: Intl.DateTimeFormatOptions,
  locale: string = DEFAULT_LOCALE,
): Intl.DateTimeFormat {
  const id = `${locale}|${tz}|${JSON.stringify(opts)}`;
  let f = formatters.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts });
    formatters.set(id, f);
  }
  return f;
}
