# Comms page: build target (operator-approved 26 Oct 2026)

The operator signed this off as a **1:1 build target**. Build what it shows; the sample messages,
tickets and counts are illustration only. `comms.dc.html` is the mockup source: the markup gives
layout, colours and type (the HUD tokens from `apps/web/src/hud.css`), and the script at the bottom
shows the behaviour. It runs only in the design canvas, so read it rather than opening it.

Supersedes #685 (the old graph fix) and the Comms part of #677.

## The page

1. **Decisions** (replaces Needs you). One card per decision: who asks, the ticket, the ask, the
   recommendation, the default and a countdown to it. Buttons: Accept default · Discuss (opens the
   asker's conversation with "Re #n: " typed) · Held (held on purpose: stop pinging).
2. **Left nav.** FLIGHT ↔ CAPCOM, #crew, then **Agents**: every seat in the live crew. Seats that are
   added or removed appear and go without a reload. Each row: state word, 24h message count, unread.
3. **#crew.** Every agent and CAPCOM reads and posts. `@name` pings one agent.
4. **Agent page.** Picking an agent opens its contacts: **Inbox · what it reads**, **All messages**
   (everything it sent and received), then each agent it talked to, with a count and last message.
   Picking a contact shows the messages between the two. No top-level agent↔agent threads.
   CAPCOM can message the agent directly from here (marked operator).
5. **Breadcrumb**, e.g. Comms › Agents › guido-cx › retro-cx.
6. **Mentions bell**, fixed at the top right of the chat bar (text never moves it). The count is new
   tags on CAPCOM. It opens a panel: one row per tag (who, where, time, message cut to two lines),
   newest first. Clicking a row opens that conversation, scrolls to the message and highlights it.
   The row then loses its alert and stays, greyed, as seen. Mark all read. Tags on CAPCOM are amber
   everywhere; CAPCOM's own messages are blue.
7. **Reply to a message.** Reply shows on hover or focus. The composer shows "Replying to …" with ×.
   The sent message carries a quote of the original; clicking the quote jumps to it. The original
   sender is pinged.
8. **Ticket view.** Every `#n` or `PR n` pill opens all messages about that ticket and its PR, across
   conversations, in time order, under a strip with title, status, owner and Open on Board.
9. **Message labels**, a fixed set of three: question · handoff · blocker. FYI is unlabelled. A
   question or blocker with no answer shows how long it has waited and when it goes to FLIGHT.
10. **Reactions**, a fixed set of four: seen · on it · done · can't (with a short reason). A mark on
    the message, never a new message: no wake-up, no tokens. CAPCOM's Ack is "seen".
11. **Pins.** Pinned messages (standing orders) sit at the top of #crew and in every seat's inbox.
12. **Layout.** The page fills the window. The composer is pinned to the bottom of the conversation,
    which scrolls above it with the newest at the bottom. Side columns run full height. No dead space.
13. **Comms graph.** Laid out from the live crew (FLIGHT centre, CAPCOM top, the rest on a ring; any
    number of seats). Dots travel each link in the sender's colour, both ways; busier links get more
    and faster dots. It follows the page: the agent or pair in view lights up, the rest dims. A node
    click opens that agent. Msgs / Tokens switch.
14. **Chatter watch** under the graph: a pair over 6 rounds on one ticket turns its link amber and is
    listed with its token cost. FLIGHT steps in.
15. **Traffic.** Stats and 24h hourly bars for what is in view; for an agent, sent vs received.
16. All of it live from hub resources. No refresh.

## Not doing

A catch-up summary (one summary can miss context), message → ticket (a ticket still needs its
requirements written), per-conversation notification levels.
