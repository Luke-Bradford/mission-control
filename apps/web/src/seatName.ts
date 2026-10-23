import type { Crew } from "@mc/core";
import { useCallback } from "react";
import { seatName } from "./crew.ts";
import { RESOURCES, useResource } from "./data.ts";

/** Subscribe labels to crew updates, including a rename. */
export function useSeatName(): (id: string) => string {
  const rows = useResource<Crew>(RESOURCES.crew).data?.rows;
  return useCallback((id: string) => seatName(id, rows), [rows]);
}
