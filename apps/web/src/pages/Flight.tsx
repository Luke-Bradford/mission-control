import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
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
import { NEEDS_YOU_PANEL, navigate, useHash } from "../router.ts";
import "../flight/flight.css";

const FLIGHT_TABS = ["command", "queue", "notebook", "record"] as const;
type FlightTab = (typeof FLIGHT_TABS)[number];

const TAB_LABEL: Record<FlightTab, string> = {
  command: "Command",
  queue: "Plan",
  notebook: "Notebook",
  record: "Record",
};

/** Panels a link may name, by the tab that holds them; a working-context or draft row by prefix. */
const HASH_TAB: Readonly<Record<string, FlightTab>> = {
  briefP: "notebook",
  memoryP: "notebook",
  ledgerP: "queue",
  [NEEDS_YOU_PANEL]: "queue",
  draftsP: "queue",
  incP: "queue",
  watchP: "queue",
  outcomesP: "record",
  decidedP: "record",
  logP: "record",
};

/** The tab a `#fragment` link opens: the one holding it, else Command. */
export function tabForHash(hash: string): FlightTab {
  const id = hash.replace(/^#/, "");
  if (id.startsWith("flight-note-")) return "notebook";
  if (id.startsWith("draft-")) return "queue";
  return HASH_TAB[id] ?? "command";
}

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

/**
 * A tab's panel. It takes focus itself (WAI-ARIA tabs pattern) so a keyboard user reaches a panel
 * that opens with no focusable content, and its `flight-<tab>` class carries the tab's layout.
 */
function TabPanel({
  tab,
  current,
  children,
}: {
  tab: FlightTab;
  current: FlightTab;
  children: ReactNode;
}) {
  return (
    <div
      className={`flight-tab-body flight-${tab}`}
      id={`flight-${tab}`}
      role="tabpanel"
      aria-labelledby={`flight-tab-${tab}`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the APG tabs pattern makes a tabpanel a tab stop.
      tabIndex={0}
      hidden={tab !== current}
    >
      {children}
    </div>
  );
}

/** FLIGHT's shared command surface: one canonical home for now, next, context and history. */
export function Flight() {
  const hash = useHash();
  const [tab, setTab] = useState<FlightTab>(() => tabForHash(hash));
  // A link to a section opens its tab, on load and when the fragment changes on this page.
  useEffect(() => {
    if (hash === "") return;
    setTab(tabForHash(hash));
    // The target was hidden while its tab was, so the browser could not scroll to it.
    requestAnimationFrame(() =>
      document.getElementById(hash.slice(1))?.scrollIntoView?.({
        block: "nearest",
      }),
    );
  }, [hash]);
  // A tab chosen by hand drops a section link the page no longer shows, so following it again
  // switches back.
  const select = (next: FlightTab) => {
    setTab(next);
    if (window.location.hash !== "") {
      navigate(window.location.pathname + window.location.search, { replace: true });
    }
  };
  return (
    <section id="page-flight">
      <h1 className="sr-only">Flight</h1>
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
            onClick={() => select(item)}
            onKeyDown={(event) => moveTab(event, item, select)}
          >
            <span className="flight-tab-index" aria-hidden="true">
              {String(FLIGHT_TABS.indexOf(item) + 1).padStart(2, "0")}
            </span>
            {TAB_LABEL[item]}
          </button>
        ))}
      </div>

      <TabPanel tab="command" current={tab}>
        <Situation />
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
              <ControlQueue onOpenQueue={() => select("queue")} />
            </div>
          </Panel>
        </div>
      </TabPanel>

      <TabPanel tab="queue" current={tab}>
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
            id={NEEDS_YOU_PANEL}
            title="Operator actions"
            sub="decisions and replies only you can make"
          >
            <div className="flight-panel-scroll">
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
      </TabPanel>

      <TabPanel tab="notebook" current={tab}>
        <BriefPanel expanded />
        <MemoryPanel expanded />
      </TabPanel>

      <TabPanel tab="record" current={tab}>
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
      </TabPanel>
    </section>
  );
}
