import { COMMS_CREW } from "@mc/core";
import { useCallback, useMemo } from "react";
import {
  COMMS_CHART_PATH,
  commsAgentPath,
  commsContactPath,
  commsCrewPath,
  commsFlightPath,
  navigate,
  useSearch,
} from "../router.ts";
import { type ChartFilter, focusFromSearch, pairFilter, searchWithFocus } from "./commsFilter.ts";
import { CAPCOM } from "./useChartData.ts";

/** The conversation a filter opens in Comms: a seat's own, a pair's, FLIGHT ↔ CAPCOM, or #crew. */
export function filterPath(filter: ChartFilter, flight: string): string {
  if (filter.kind === "seat") {
    if (filter.id === CAPCOM || filter.id === flight) return commsFlightPath();
    return filter.id === COMMS_CREW ? commsCrewPath() : commsAgentPath(filter.id);
  }
  const { a, b } = filter;
  if (new Set([a, b, flight, CAPCOM]).size === 2) return commsFlightPath();
  if (a === COMMS_CREW || b === COMMS_CREW) return commsCrewPath();
  const [agent, contact] = a === CAPCOM ? [b, a] : [a, b];
  return commsContactPath(agent, contact);
}

/** A link from the pop-out page to the Comms page, keeping the chart narrowed the same way. */
export const commsHrefFor = (filter: ChartFilter, flight: string): string =>
  `${filterPath(filter, flight)}${searchWithFocus("", filter)}`;

/** The pop-out's address, keeping the filter. */
export const chartHref = (filter: ChartFilter | null): string =>
  `${COMMS_CHART_PATH}${searchWithFocus("", filter)}`;

/** The filter in the URL (`?focus=`), and a way to set or clear it that keeps the page. */
export function useChartFilter(known: ReadonlySet<string>) {
  const search = useSearch();
  const filter = useMemo(() => focusFromSearch(search, known), [search, known]);
  const set = useCallback((next: ChartFilter | null) => {
    const { pathname, search: now, hash } = window.location;
    navigate(`${pathname}${searchWithFocus(now, next)}${hash}`);
  }, []);
  return [filter, set] as const;
}

export { pairFilter };
