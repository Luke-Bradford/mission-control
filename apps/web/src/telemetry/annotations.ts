/** Events that explain an operator-visible change, rather than telemetry polling noise. */
const CHART_EVENT_KINDS = new Set(["crew-paused", "crew-resumed", "hub-update", "quota-reset"]);

/** Keep the annotation layer focused on events an operator can act on. */
export function chartAnnotations(
  events: readonly { at: number; kind: string; cause: string }[],
): { at: number; label: string }[] {
  return events
    .filter((event) => CHART_EVENT_KINDS.has(event.kind))
    .map((event) => ({ at: event.at, label: event.cause }));
}
