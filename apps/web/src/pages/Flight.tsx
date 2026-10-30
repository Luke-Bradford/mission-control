import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import { CrewBoardTab } from "../flight/CrewBoardTab.tsx";
import { DidTab } from "../flight/DidTab.tsx";
import { KnowsTab } from "../flight/KnowsTab.tsx";
import { NeedsYouTab } from "../flight/NeedsYouTab.tsx";
import { StatusStrip } from "../flight/Situation.tsx";
import { FLIGHT_TABS, type FlightTab, TAB_LABEL, tabForHash } from "../flight/tabs.ts";
import { navigate, useHash } from "../router.ts";
import "../flight/flight.css";

export { tabForHash };

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
 * A tab's panel. Only the selected tab's content is mounted, so a hidden tab fetches nothing and
 * keeps no timer running; the panel stays in the page for the tabs' ARIA relationship. It takes focus itself (WAI-ARIA tabs pattern) so a keyboard user reaches a panel
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

/** FLIGHT's page: a status strip over four tabs named for the operator's questions. */
export function Flight() {
  const hash = useHash();
  const [tab, setTab] = useState<FlightTab>(() => tabForHash(hash));
  // A link to a section opens its tab, on load and when the fragment changes on this page.
  useEffect(() => {
    if (hash === "") return;
    setTab(tabForHash(hash));
    // The target was hidden while its tab was, so the browser could not scroll to it.
    requestAnimationFrame(() => {
      const target = document.getElementById(hash.slice(1));
      // A section folded in a collapsed disclosure (working context) opens to show the link's target.
      for (let d = target?.closest("details"); d; d = d.parentElement?.closest("details")) {
        d.open = true;
      }
      target?.scrollIntoView?.({ block: "nearest" });
    });
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
      <StatusStrip onOpen={select} />
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
      <TabPanel tab="needs" current={tab}>
        {tab === "needs" && <NeedsYouTab />}
      </TabPanel>
      <TabPanel tab="did" current={tab}>
        {tab === "did" && <DidTab />}
      </TabPanel>
      <TabPanel tab="crew" current={tab}>
        {tab === "crew" && <CrewBoardTab />}
      </TabPanel>
      <TabPanel tab="knows" current={tab}>
        {tab === "knows" && <KnowsTab />}
      </TabPanel>
    </section>
  );
}
