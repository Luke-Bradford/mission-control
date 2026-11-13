import type { Page } from "../src/router.ts";

/**
 * The link map: for every page, each kind of clickable thing, where it goes, and why that is where
 * the operator expects. `LinkCrawl.test.tsx` clicks every anchor on every page in Demo and fails
 * when one goes somewhere the map does not say, or is not in the map at all.
 *
 * The rule of thumb behind the targets: an item goes to its own page with its context (a ticket to
 * the ticket page, a waiting decision to its Needs you page, a seat to its Agent page); GitHub is
 * always a separate, labelled link that opens in a new tab.
 */
export interface LinkRule {
  /** The element's words (its aria-label, else its text). */
  text: RegExp;
  /** Narrows the rule to elements whose class matches, when the words alone are not enough. */
  cls?: RegExp;
  /** Where it goes: path, query and fragment, or EXTERNAL for another site. */
  target: RegExp;
  /** Why that target. */
  why: string;
}

const rule = (text: RegExp, target: RegExp, why: string, cls?: RegExp): LinkRule => ({
  text,
  target,
  why,
  ...(cls ? { cls } : {}),
});

const TICKET = /^\/tickets\/[\w-]+\/\d+$/;
const EXTERNAL = /^external$/;

/** On every page: the header, the dock and what any page shows the same way. */
export const EVERYWHERE: LinkRule[] = [
  rule(/^Overview$/, /^\/$/, "Header tab: the Overview page."),
  rule(/^Needs you: \d+ waiting$/, /^\/needs-you$/, "The Needs you pulse leads to all of it."),
  rule(/^Flight$/, /^\/flight$/, "Header tab."),
  rule(/^Board$/, /^\/board$/, "Header tab."),
  rule(/^Agents$/, /^\/agent$/, "Header tab."),
  rule(/^Comms$/, /^\/comms$/, "Header tab."),
  rule(/^QA$/, /^\/qa$/, "Header tab."),
  rule(/^Telemetry$/, /^\/telemetry$/, "Header tab."),
  rule(/^Audit$/, /^\/audit$/, "Header tab."),
  rule(/^Open FLIGHT's full view$/, /^\/flight$/, "The dock's summary leads to the FLIGHT page."),
  rule(
    /on GitHub$|^Open in GitHub|^View on GitHub|^PR #\d+$/,
    EXTERNAL,
    "GitHub is its own link, in a new tab.",
  ),
  rule(
    /^[\w-]+ ?#\d+$|^[\w-]+#\d+$|^Open [\w-]+#\d+/,
    TICKET,
    "A ticket reference opens the ticket page: the form, who is on it, and what the crew did.",
  ),
  rule(
    /^[\w-]+ PR #\d+$/,
    TICKET,
    "A PR reference on a card opens the ticket page the PR belongs to; its GitHub link is separate.",
  ),
  rule(/^Trace$/, /^\/agent\/[\w-]+\?trace=[\w-]+$/, "The run's trace on its seat's page."),
];

export const LINK_MAP: Record<
  Page | "ticket" | "commsChart",
  { routes: string[]; rules: LinkRule[] }
> = {
  overview: {
    routes: ["/"],
    rules: [
      rule(/^head agent/, /^\/flight$/, "FLIGHT's seat opens the FLIGHT page, its own view."),
      rule(/^(dev|[a-z]+)-\d+$/, /^\/agent\/[\w-]+$/, "A seat's name opens its Agent page."),
      rule(
        /^(Ready|Building|In review|Merging|Done)/,
        /^\/board\?stage=\w+$/,
        "A pipeline stage opens the Board filtered to that stage.",
      ),
      rule(/^#\d+ /, TICKET, "A card in the pipeline opens its ticket page."),
      rule(/^(Mac|Tokens)$/, /^\/telemetry$/, "Resource figures lead to Telemetry."),
      rule(/-main$/, /^\/setup\/accounts$/, "An account chip opens Setup accounts."),
    ],
  },
  needs: {
    routes: ["/needs-you"],
    rules: [
      rule(
        /^(Decision|Question|Plan|Escalation)/,
        /^\/needs-you\/[^/]+$/,
        "A waiting item opens beside the list, with its context, pictures, recommendation and options.",
      ),
      rule(/'s page$/, /^\/agent\/[\w-]+$/, "The seat that asked."),
      rule(/^Open the full ticket$/, TICKET, "The ticket page."),
      rule(/^Open on GitHub$/, EXTERNAL, "GitHub, in a new tab."),
    ],
  },
  flight: {
    routes: ["/flight"],
    rules: [rule(/^Records$/, /^\/flight#handlingP$/, "Jumps to the records on the same page.")],
  },
  board: {
    routes: ["/board", "/board/shop-app"],
    rules: [
      rule(/^QA report for /, /^\/qa\?repo=[\w-]+&pr=\d+$/, "The PR's readiness page in QA."),
      rule(
        /./,
        TICKET,
        "A card's title opens the ticket page, never an agent: the seat on the card may not be on the ticket. The ticket page names who is.",
        /\bktitle\b/,
      ),
      rule(/^Skip to board$/, /^\/board(\/[\w-]+)?#board-content$/, "Keyboard skip link."),
    ],
  },
  ticket: {
    routes: ["/tickets/shop-app/102"],
    rules: [rule(/^← Board$/, /^\/board\/[\w-]+$/, "Back to the ticket's repo board.")],
  },
  agent: {
    routes: ["/agent/dev-1", "/agent/flight-1"],
    rules: [rule(/^Open this seat in Audit$/, /^\/audit\?seat=[\w-]+$/, "The seat's audit rows.")],
  },
  comms: {
    routes: ["/comms", "/comms/crew", "/comms/agents/dev-1", "/comms/agents/dev-1/contacts/dev-2"],
    rules: [
      rule(/^\d+ waiting for you$/, /^\/needs-you$/, "Needs you."),
      rule(/^Open the chart full screen$/, /^\/comms\/chart$/, "The chart on its own."),
      rule(
        /^Your conversation with /,
        /^\/comms\/agents\/[\w-]+\/contacts\/CAPCOM$/,
        "A thread between two agents is read-only; the operator talks to the agent in their own conversation.",
      ),
    ],
  },
  commsChart: {
    routes: ["/comms/chart"],
    rules: [
      rule(/^\d+ waiting for you$/, /^\/needs-you$/, "Needs you."),
      rule(/^← Comms$/, /^\/comms$/, "Back to Comms."),
    ],
  },
  qa: {
    routes: ["/qa", "/qa?view=history"],
    rules: [
      rule(/^Current$/, /^\/qa$/, "The queue."),
      rule(/^History$/, /^\/qa\?view=history$/, "Past reviews."),
      rule(/· PR #\d+ ·/, /^\/qa\?repo=[\w-]+&pr=\d+$/, "A queued PR opens its readiness report."),
      rule(/^Open preview$/, EXTERNAL, "The PR's running preview, in a new tab."),
      rule(/^Open PR #\d+ on GitHub$/, EXTERNAL, "GitHub, in a new tab."),
      rule(/^Open code risk in Audit$/, /^\/audit\?tab=risk$/, "Code risk lives in Audit."),
      rule(
        /^Open native review for /,
        /^\/qa\?view=history&native=\d+&identity=\w+$/,
        "A saved native review.",
      ),
      rule(/^Open saved report for /, /^\/qa\?repo=[\w-]+&pr=\d+&report=\w+$/, "A saved report."),
    ],
  },
  telemetry: {
    routes: ["/telemetry"],
    rules: [
      rule(/^\d+$/, /^\/comms#cGuard$/, "A guard count opens the Comms line that explains it."),
    ],
  },
  audit: {
    routes: ["/audit"],
    rules: [
      rule(/^Code risk in Audit$/, /^\/audit\?tab=risk$/, "Code risk tab."),
      rule(/^Cost and flow context$/, /^\/telemetry$/, "Cost and flow."),
      rule(/^PR readiness and tests in QA$/, /^\/qa$/, "PR readiness."),
    ],
  },
  setup: {
    routes: ["accounts", "sessions", "repos", "loops", "roles", "sources", "access"].map(
      (t) => `/setup/${t}`,
    ),
    rules: [],
  },
};

/** Buttons the crawl clicks too (it clicks no others: most act in place), with where they go. */
export const NAVIGATING_BUTTONS: { routes: string[]; text: RegExp; target: RegExp; why: string }[] =
  [
    {
      routes: ["/board"],
      text: /^You:/,
      target: /^\/needs-you\/[^/]+$/,
      why: "The chip names what waits on the operator; its Needs you page has the context, pictures, recommendation and options. The side pane has none of them.",
    },
  ];

/**
 * Every source file that makes something navigate (`navigate(`, `openItem(`, `followLink(` or an
 * `href=`). A new file that does must be added here, with what it opens, so its clicks are read once.
 * The kinds: page (a page of the app), pane (the side pane, `?item=`), tab (an in-page tab), external.
 */
export const NAVIGATING_FILES: Record<string, string> = {
  "src/App.tsx": "page: header tabs, skip link, legacy redirects",
  "src/agent/IdentityBand.tsx": "page: Setup sessions, the ticket",
  "src/agent/Instruments.tsx": "page: Audit rows of the seat",
  "src/agent/Overview.tsx": "page: ticket, QA, Board, trace, seat",
  "src/agent/Picker.tsx": "page: another seat",
  "src/agent/RightColumn.tsx": "page: trace, Setup, next move",
  "src/agent/RunTrace.tsx": "page: back to the seat",
  "src/agent/RunsPanel.tsx": "page: trace, hand-off run",
  "src/agent/SideTabs.tsx": "pane: an item the seat raised",
  "src/agent/chooseSeat.ts": "page: the chosen seat",
  "src/attention.ts": "page: Needs you item (pane only for items that are not the operator's)",
  "src/board/Card.tsx":
    "page: the ticket (card, title), Needs you item (You chip), seat (agent tag), trace",
  "src/browserNotifications.ts": "page: the notification's target",
  "src/code-health/CodeHealth.tsx": "page: Audit, QA, Telemetry",
  "src/code-health/CodeRisk.tsx": "page: Audit risk",
  "src/code-health/TokenAudit.tsx": "page: seat, ticket",
  "src/code-health/dialogs.tsx": "external: GitHub",
  "src/comms/ChartPane.tsx": "page: the chart full screen",
  "src/comms/CommsGraph.tsx": "page: chart filter, Needs you",
  "src/comms/Conversation.tsx":
    "page: Comms views, the ticket, the operator's own thread with an agent",
  "src/comms/TicketsList.tsx": "page: Comms ticket thread, ticket",
  "src/comms/chartPaths.ts": "page: chart filter",
  "src/comms/messages.tsx": "page: links inside message text",
  "src/components/ExternalLink.tsx": "external",
  "src/components/NeedButton.tsx": "pane: a need named in text",
  "src/components/SafeLink.tsx": "external",
  "src/components/StartSeat.tsx": "page: the started seat",
  "src/components/TicketDetail.tsx": "page: ticket, back",
  "src/components/formSupport.tsx": "fragment: the field with the error",
  "src/flight/BlockedChains.tsx": "page: ticket, seat",
  "src/flight/Brief.tsx": "fragment: notes on the page",
  "src/flight/Decided.tsx": "page: the order",
  "src/flight/FlightTabs.tsx": "tab: FLIGHT records",
  "src/flight/Incoming.tsx": "external: GitHub",
  "src/flight/NeedsYouTab.tsx": "pane: the item; page: Needs you",
  "src/flight/NotTriaging.tsx": "pane: the item",
  "src/flight/PowerRequests.tsx": "page: the request's seat",
  "src/flight/PrFlowPanel.tsx": "page: seat, QA",
  "src/flight/Situation.tsx": "tab or page: the situation line",
  "src/flight/WorkInFlight.tsx": "page: seat",
  "src/flight/page/FlightPage.tsx": "page: Board, records",
  "src/hud/PrChip.tsx": "external: GitHub; page: QA report",
  "src/hud/RepoRef.tsx": "page: ticket or QA",
  "src/instructions/Instructions.tsx": "page: seat queue",
  "src/lenses/lenses.tsx": "page: PR map",
  "src/needs/LinksSection.tsx": "page: seat",
  "src/needs/Materials.tsx": "page: ticket; external: GitHub",
  "src/needs/NeedsControls.tsx": "page: next or previous item",
  "src/needs/NeedsList.tsx": "page: the item",
  "src/needs/PreviewFrame.tsx": "external: the preview",
  "src/overview/ActivityPanel.tsx": "page: read path, seat run",
  "src/overview/AgentsPanel.tsx": "page: seat, FLIGHT, Setup",
  "src/overview/LockBox.tsx": "page: seat",
  "src/overview/MacRow.tsx": "page: Telemetry",
  "src/overview/PipelinePanel.tsx": "page: Board, ticket",
  "src/overview/TokensPanel.tsx": "page: Telemetry, Setup",
  "src/pages/Agent.tsx": "page: Setup sessions",
  "src/pages/BoardPage.tsx": "page: lane boards, Setup repos",
  "src/pages/Comms.tsx": "page: Comms views, Needs you",
  "src/pages/CommsChartPage.tsx": "page: back to Comms, chart filter",
  "src/pages/Flight.tsx": "page: legacy hash to Needs you",
  "src/pages/LegacyAudit.tsx": "page: seat, trace, board",
  "src/pages/Needs.tsx": "page: first item",
  "src/pages/QaReadiness.tsx": "page: QA, Audit; external: preview",
  "src/pages/Setup.tsx": "page: Setup tabs",
  "src/pages/TicketPage.tsx": "page: back to Board",
  "src/palette/entries.ts": "page: whatever the palette entry names",
  "src/qa/QaHistory.tsx": "page: QA views",
  "src/qa/QaReport.tsx": "page: QA, API records",
  "src/qa/TicketQaReports.tsx": "page: permanent report",
  "src/qa/frees.tsx": "page: ticket, FLIGHT chains",
  "src/router.ts": "the router itself",
  "src/setup/Sessions.tsx": "page: seat",
  "src/shell/AwayDigest.tsx": "page: its item; pane",
  "src/shell/DemoSwitch.tsx": "page: the same page, Demo on or off",
  "src/shell/DockSummary.tsx": "page: Comms message, FLIGHT",
  "src/shell/Header.tsx": "page: tabs, Setup, Needs you",
  "src/shell/ItemDetail.tsx": "pane: the item's seat, its decision",
  "src/shell/keys.ts": "page: g-key shortcuts",
  "src/shell/overlays.ts": "pane: openItem itself",
  "src/telemetry/Kpis.tsx": "page: the KPI's source",
};
