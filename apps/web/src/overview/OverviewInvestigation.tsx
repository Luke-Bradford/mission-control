import type { Crew } from "@mc/core";
import { useEffect, useState } from "react";
import { RESOURCES, useResource } from "../data.ts";
import { kTokens, plural } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { useSessionScope } from "../shell/session.ts";
import { contextCapacity } from "./ContextCapacity.tsx";
import { type History, OverviewHistoryPanel } from "./OverviewHistoryPanel.tsx";

/** This is a layout subscription only; resizing never refetches data or changes selected scope. */
export function useOverviewMedia(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const media = matchMedia(query),
      update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function ContextSummaryPanel() {
  const crew = useResource<Crew>(RESOURCES.crew),
    { inView } = useSessionScope();
  const rows = crew.data?.rows.filter((row) => row.kind === "crew" && inView(row)),
    known =
      rows?.flatMap((row) => {
        const capacity = contextCapacity(row);
        return capacity.pct !== null && capacity.window !== null
          ? [{ ...capacity, pct: capacity.pct, window: capacity.window }]
          : [];
      }) ?? [];
  return (
    <Panel id="contextSummaryP" title="Context capacity" sub="per seat · not account allowance">
      <div className="pb s">
        {!rows ? (
          <p>{crew.error ? "Context capacity could not load." : "Loading seat context…"}</p>
        ) : (
          <>
            <p>
              {known.length} of {rows.length} seats measured ·{" "}
              {plural(rows.length - known.length, "unknown window")}
            </p>
            <p>{known.filter((value) => value.pct >= 80).length} at or above 80% used.</p>
            <p className="muted">
              Compare used / window, tokens left and used % in each Crew row. Context windows belong
              to individual seats; they are not pooled.
            </p>
            {known.length > 0 && (
              <p>
                Largest measured window: {kTokens(Math.max(...known.map((value) => value.window)))}{" "}
                tokens.
              </p>
            )}
            {crew.error && (
              <p role="status" className="warn-t">
                Refresh failed · last received context shown.
              </p>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

const MEASURES: History[] = ["tokens", "spend", "inflight", "ci", "needs"];
export function OverviewHistoryComparison() {
  const visible = useOverviewMedia("(min-width: 2800px) and (min-height: 1600px)");
  return visible ? (
    <section className="overview-comparisons" aria-label="Measured history comparison">
      {MEASURES.map((measure) => (
        <OverviewHistoryPanel key={measure} measure={measure} />
      ))}
    </section>
  ) : null;
}
