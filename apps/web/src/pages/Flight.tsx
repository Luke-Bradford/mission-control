import { useEffect } from "react";
import { FlightTabs } from "../flight/FlightTabs.tsx";
import { FlightPage } from "../flight/page/FlightPage.tsx";
import { isFlightRecordHash } from "../flight/records.ts";
import { LEGACY_NEEDS_HASHES, NEEDS_YOU_PATH, navigate, useHash } from "../router.ts";

/** FLIGHT's page: status, what it is doing, what blocks it and its recent decisions on one screen. */
export function Flight() {
  const hash = useHash();
  useEffect(() => {
    if (LEGACY_NEEDS_HASHES.includes(hash)) navigate(NEEDS_YOU_PATH, { replace: true });
  }, [hash]);
  if (isFlightRecordHash(hash)) return <FlightTabs records />;
  return <FlightPage />;
}
