# Comms and Ticket page: rendered proposal for approval

This proposal makes Comms the conversation record and puts the work, question, exact answer and history together on the Ticket page. It is ready for a layout decision. It does not complete #1513 or approve application work.

The existing draft is PR #1600 at `708bbe76f08196ad2ccde7368c0189f0bbc0f8a6`. All after layouts use three preview-only test files and a Vite resolver alias. No production source, native author branch, run or budget stop changed. This evidence branch is based on main after the question-lifecycle merge; it does not contain a competing implementation.

## Start here

| View | Before | Proposal |
|---|---|---|
| Comms, 1600×1000 dark | [Before](comms-before-1600x1000-dark.png) | [Proposal](comms-after-1600x1000-dark.png) |
| Ticket, 1600×1000 dark | [Before](ticket-before-1600x1000-dark.png) | [Proposal](ticket-after-1600x1000-dark.png) |
| Comms, 1600×700 light | [Before](comms-before-1600x700-light.png) | [Proposal](comms-after-1600x700-light.png) |
| Ticket, 1280×900 dark | [Before](ticket-before-1280x900-dark.png) | [Proposal](ticket-after-1280x900-dark.png) |

Local interactive proposal: <http://127.0.0.1:7461/test/desktopBrowser.html?path=%2Fcomms%2Fcrew>. It serves controlled fictional data and refuses message sends. The built preview remains outside the application checkout.

## What the layout proposes

- Team, FLIGHT and you, crew, and a separate FLIGHT/controller conversation, followed by scrollable Agents and searchable Tickets.
- Labelled all-recorded message counts. One unread dot marks a reply to the operator; opening that thread clears the preview mark. Controller messages do not create that dot.
- Stored-kind tags for YOU, CONTROLLER, FLIGHT, seat and HUB. The hub contact opens its retained notices.
- Ticket titles open the Ticket page. A separate Filter chat button opens that ticket's conversation.
- Waiting on a reply uses words and ages. The graph gets its separate route under the newer graph ticket. Decisions remain on Needs you; the visible Mentions control is removed.
- The Ticket page pairs a question with its exact answer and expandable surrounding conversation. The separately scrolling record includes questions, answers, Not now reasons, handoffs, notices and messages.

## Observations and checks

The controller rendered the actual App shell and inspected settled images at normal, narrower and short viewports in both themes. The conversation is the main reading surface; the left lists identify the thread and ticket, and the smaller right column identifies who owes a reply. At 1280 the longer ticket titles wrap, while the ticket list and agent list scroll independently. At 1600×700 fewer agent rows are visible, and the composer remains on screen. The Ticket page keeps the work and exact answer on the left while its longer record scrolls on the right. Its last entry is reachable without scrolling the page shell.

The 32 matched before/after images cover both pages, four viewport sizes and both themes. The same explicitly fictional message cohort supplies counts and messages: 50 crew lines, labelled contact totals and four ticket counts. The before images were reconstructed during this capture, not backdated. Capture times, source hashes, geometry and image hashes are retained in [receipt.json](receipt.json) and [manifest.json](manifest.json).

[Seventeen interaction observations](interactions.json) cover controller and hub threads, one unread dot and its clearing, empty search, separate filter/open navigation, question and record context, scrolling to the last record, and a retry example. The exercised ordinary paths had no browser errors or failed API reads. The extra six state images deliberately show empty, loading and error examples for Comms and the Ticket record; the Comms error uses an injected 503. These are proposal checks, not production acceptance tests.

[Hub conversation](interaction-hub-contact-1600x700-light.png) · [Question and answer context](interaction-question-answer-1600x700-light.png) · [Last record entry](interaction-ticket-context-1600x700-light.png).

[Comms empty](comms-state-empty-1280x900-dark.png) · [Comms loading](comms-state-loading-1280x900-dark.png) · [Comms error](comms-state-error-1280x900-dark.png) · [Ticket empty](ticket-state-empty-1280x900-dark.png) · [Ticket loading](ticket-state-loading-1280x900-dark.png) · [Ticket error](ticket-state-error-1280x900-dark.png).

## Decision and limits

Recommend approving this layout so the existing ticket can proceed through its supported author handoff, implementation and independent review. The mockup includes later unread, Mentions and graph-direction amendments. Its action-settlement text illustrates the intended lifecycle; it does not prove that lifecycle against a live server. The existing graph view is outside this proposal and is not presented as the new graph implementation. Browser notifications and real message sends are not exercised.

The ticket explicitly requires: “Before the build … render Comms and the Ticket page busy in the real app on a branch and show the operator. The build starts on their yes.” No yes is inferred from this packet. Application work stays held until the operator answers the one layout question presented by FLIGHT.

Sources: [design contract](design-contract.md), [fixture](fixture.json), and [preview harness](harness/). The capture harness records local machine paths; to reproduce, check out the preserved draft head, install its locked dependencies with Node 26, copy the three controller1513 test files into `apps/web/test`, and adjust the harness worktree, output-pointer and local Chromium paths. Its before build uses the original modules; its after build aliases four page modules to the preview module. No production file is edited.
