import type { AttentionItem, Crew, LimitRow } from "@mc/core";
import { useEffect } from "react";
import { Header } from "../agent/Header.tsx";
import { NeedBanner } from "../agent/NeedBanner.tsx";
import { Picker } from "../agent/Picker.tsx";
import { RunsPanel } from "../agent/RunsPanel.tsx";
import { SideTabs } from "../agent/SideTabs.tsx";
import { StreamPanel } from "../agent/StreamPanel.tsx";
import { interruptSeat, seatError } from "../agent/seat.ts";
import { useSecond, useTz } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { setPageKey } from "../shell/keys.ts";
import { getSelectedAgent, setSelectedAgent, useSelectedAgent } from "../shell/selection.ts";
import { inSession, useSession } from "../shell/session.ts";
import { toast } from "../shell/Toast.tsx";

/**
 * One agent in detail (catalogue §2.4): picker, need banner, header and tiles, then Activity beside
 * Runs and the side tabs. `/agent` with no id shows the selected agent, else the first running crew seat,
 * else the first crew seat, else the first in view.
 */
export function Agent({ id }: { id: string | null }) {
  const crew = useResource<Crew>(RESOURCES.crew);
  const items = useResource<AttentionItem[]>(RESOURCES.attention).data ?? [];
  const limits = useResource<LimitRow[]>(RESOURCES.limits).data ?? [];
  const tz = useTz();
  const now = useSecond();
  const [session] = useSession();
  const [selected] = useSelectedAgent();

  const all = crew.data ? [...crew.data.rows].sort((a, b) => a.index - b.index) : null;
  const inView = all?.filter((r) => inSession(session, r.repoId)) ?? [];
  const crewSeats = inView.filter((r) => r.kind === "crew");
  const row =
    all === null
      ? null
      : ((id !== null
          ? all.find((r) => r.id === id)
          : (inView.find((r) => r.id === selected) ??
            crewSeats.find((r) => r.hudState === "running") ??
            crewSeats[0] ??
            inView[0])) ?? null);
  const shownId = row?.id ?? null;

  // The selection follows the agent on screen, so j/k step from it.
  useEffect(() => {
    if (shownId !== null && shownId !== getSelectedAgent()) setSelectedAgent(shownId);
  }, [shownId]);

  // `i` interrupts a crew seat; an observed loop is never interrupted, so it says so.
  const shownKind = row?.kind ?? null;
  useEffect(() => {
    if (shownId === null) return;
    setPageKey("i", () => {
      if (shownKind === "crew") {
        interruptSeat({ id: shownId }).catch((e) => toast(seatError(e)));
      } else {
        toast(`${shownId} is an observed loop; Mission Control does not interrupt it.`);
      }
    });
    return () => setPageKey("i", null);
  }, [shownId, shownKind]);

  let missing: string | null = null;
  if (crew.error && !crew.data) missing = "Could not load the crew.";
  else if (!crew.data) missing = "Loading…";
  else if (id !== null && !row) missing = `No agent called ${id}.`;
  else if (!row) missing = "No agents in this session.";

  return (
    <section id="page-agent">
      <Picker rows={inView} items={items} current={shownId} />
      {row ? (
        <>
          <NeedBanner row={row} items={items} now={now} />
          <Header row={row} limits={limits} now={now} />
          <div className="agrid">
            <StreamPanel key={`s:${row.id}`} row={row} now={now} tz={tz} />
            <div className="side">
              <RunsPanel key={`r:${row.id}`} row={row} now={now} tz={tz} />
              <SideTabs key={`t:${row.id}`} row={row} />
            </div>
          </div>
        </>
      ) : (
        <p className={crew.error && !crew.data ? "pb crit-t" : "pb muted"}>{missing}</p>
      )}
    </section>
  );
}
