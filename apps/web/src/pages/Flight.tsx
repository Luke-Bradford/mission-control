import { type KeyboardEvent, useState } from "react";
import { AskedOfYou } from "../flight/AskedOfYou.tsx";
import { BriefPanel, WatchList } from "../flight/Brief.tsx";
import { ControlQueue } from "../flight/ControlQueue.tsx";
import { Decided } from "../flight/Decided.tsx";
import { Drafts } from "../flight/Drafts.tsx";
import { Incoming } from "../flight/Incoming.tsx";
import { MemoryPanel } from "../flight/Memory.tsx";
import { Situation } from "../flight/Situation.tsx";
import { Summary } from "../flight/Summary.tsx";
import { WorkInFlight } from "../flight/WorkInFlight.tsx";
import { WorkingLog } from "../flight/WorkingLog.tsx";
import { Panel } from "../hud/Panel.tsx";

const FLIGHT_TABS = ["command", "queue", "notebook", "record"] as const;
type FlightTab = (typeof FLIGHT_TABS)[number];

const TAB_LABEL: Record<FlightTab, string> = {
  command: "Command",
  queue: "Plan",
  notebook: "Notebook",
  record: "Record",
};

const initialTab = (): FlightTab =>
  globalThis.location?.hash.startsWith("#flight-note-") ? "notebook" : "command";

function moveTab(
  event: KeyboardEvent<HTMLButtonElement>,
  current: FlightTab,
  select: (tab: FlightTab) => void,
) {
  const index = FLIGHT_TABS.indexOf(current);
  const next =
    event.key === "Home"
      ? FLIGHT_TABS[0]
      : event.key === "End"
        ? FLIGHT_TABS.at(-1)
        : event.key === "ArrowRight"
          ? FLIGHT_TABS[(index + 1) % FLIGHT_TABS.length]
          : event.key === "ArrowLeft"
            ? FLIGHT_TABS[(index - 1 + FLIGHT_TABS.length) % FLIGHT_TABS.length]
            : undefined;
  if (!next) return;
  event.preventDefault();
  select(next);
  document.getElementById(`flight-tab-${next}`)?.focus();
}

/** FLIGHT's shared command surface: one canonical home for now, next, context and history. */
export function Flight() {
  const [tab, setTab] = useState<FlightTab>(initialTab);
  return (
    <section id="page-flight">
      <div className="flight-tabs" role="tablist" aria-label="Flight views">
        {FLIGHT_TABS.map((item) => (
          <button
            type="button"
            role="tab"
            key={item}
            id={`flight-tab-${item}`}
            aria-controls={`flight-${item}`}
            aria-selected={tab === item}
            tabIndex={tab === item ? 0 : -1}
            onClick={() => setTab(item)}
            onKeyDown={(event) => moveTab(event, item, setTab)}
          >
            <span className="flight-tab-index" aria-hidden="true">
              {String(FLIGHT_TABS.indexOf(item) + 1).padStart(2, "0")}
            </span>
            {TAB_LABEL[item]}
          </button>
        ))}
      </div>

      <div
        className="flight-tab-body flight-command"
        id="flight-command"
        role="tabpanel"
        aria-labelledby="flight-tab-command"
        hidden={tab !== "command"}
      >
        <Situation onOpen={(target) => setTab(target)} />
        <div className="flight-command-grid">
          <Panel
            id="wifP"
            title="Delivery board"
            sub="LIVE · workstream, owner, delivery stage, next action and checkpoint"
          >
            <div className="flight-panel-scroll">
              <WorkInFlight />
            </div>
          </Panel>
          <Panel
            id="controlP"
            title="Stand-up focus"
            sub="what to clear, what follows, and what FLIGHT is watching"
          >
            <div className="flight-panel-scroll">
              <ControlQueue onOpenQueue={() => setTab("queue")} />
            </div>
          </Panel>
        </div>
      </div>

      <div
        className="flight-tab-body flight-queue"
        id="flight-queue"
        role="tabpanel"
        aria-labelledby="flight-tab-queue"
        hidden={tab !== "queue"}
      >
        <Panel
          id="ledgerP"
          title="Planning board"
          sub="FLIGHT · what is waiting, what comes next, why, and when it must be revisited"
        >
          <div className="flight-panel-scroll">
            <Summary mode="queue" />
          </div>
        </Panel>
        <div className="flight-queue-lower">
          <Panel
            id="operatorDeskP"
            title="Operator actions"
            sub="decisions and replies only you can make"
          >
            <div className="flight-panel-scroll" id="askP">
              <AskedOfYou />
            </div>
          </Panel>
          <Panel
            id="draftsP"
            title="Draft replies"
            sub="full working space for replies awaiting approval"
          >
            <div className="flight-panel-scroll">
              <Drafts />
            </div>
          </Panel>
          <div className="flight-queue-signals">
            <Panel id="incP" title="Arrivals" sub="what came in and how FLIGHT routed it">
              <div className="flight-panel-scroll">
                <Incoming />
              </div>
            </Panel>
            <Panel
              id="watchP"
              title="Revisit triggers"
              sub="structured follow-ups with an exact action when one is available"
            >
              <div className="flight-panel-scroll">
                <WatchList />
              </div>
            </Panel>
          </div>
        </div>
      </div>

      <div
        className="flight-tab-body flight-notebook"
        id="flight-notebook"
        role="tabpanel"
        aria-labelledby="flight-tab-notebook"
        hidden={tab !== "notebook"}
      >
        <BriefPanel expanded />
        <MemoryPanel expanded />
      </div>

      <div
        className="flight-tab-body flight-record"
        id="flight-record"
        role="tabpanel"
        aria-labelledby="flight-tab-record"
        hidden={tab !== "record"}
      >
        <Panel id="outcomesP" title="Outcomes" sub="recently completed work and the last 24 hours">
          <div className="flight-panel-scroll">
            <Summary mode="record" />
          </div>
        </Panel>
        <div className="flight-record-side">
          <Panel
            id="decidedP"
            title="Decided without you"
            sub="today · decisions FLIGHT made autonomously"
          >
            <div className="flight-panel-scroll">
              <Decided />
            </div>
          </Panel>
          <WorkingLog />
        </div>
      </div>
    </section>
  );
}
