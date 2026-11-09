# Operational consoles and control rooms

Read this when the page does more than show figures: the reader acts on it, or it shows things with a
life of their own (jobs, agents, orders, machines, tickets, incidents). Admin panels, ops consoles,
queue managers and control rooms are this kind of page. Everything in the other references still
applies. This file covers what they leave out.

The reader's loop is: notice, understand, decide, act, confirm it worked. A console is judged on how
short that loop is, and on whether the reader can trust what it says while they are not looking.

## Status and liveness

Each thing on the page is in a state. Design the states before the screen.

- **One vocabulary.** A short, closed list of states (for example running, waiting, blocked, failed,
  done, unknown), with one word, one shape and one colour each, used on every page. Two words for one
  state, or one word for two, costs the reader trust.
- **Say what the state means for the reader.** "Waiting for review" is useful; an internal state name
  is not. Separate "needs you" from "busy" from "idle": they call for different responses.
- **State plus age.** Show how long the thing has been in its state, and keep that ticking. "Blocked"
  is information; "blocked 47 min" is a decision.
- **Liveness comes from evidence.** A stored flag saying "running" proves nothing. Show the time of the
  last sign of life (heartbeat, output, log line), and when that is older than expected show the thing
  as silent or unknown, not as running. This is the commonest way a console lies.
- **Unknown is a state.** When the console cannot tell, it says so. It never falls back to the last
  good state or to "OK".
- **Show what a blocked thing is waiting on**, and link to it.
- **Expected against actual.** A thing can be running and still wrong: slow, looping, making no
  progress. Where normal duration or throughput is known, show the comparison.
- **Roll up honestly.** A group's status is its worst member's, with counts ("7 running, 1 blocked"),
  never an average.

## The attention queue

A list of things that need the reader is an inbox. It is the most valuable panel on a console and the
easiest to ruin.

- **An entry rule, enforced.** Only items this reader can act on, now. Status reports, items for someone
  else and things the system will fix by itself do not qualify. One bad item teaches the reader to skim.
- **One decision per item**, stated so that it stands alone: what it is, what is being asked, the
  options, what happens if nothing is done.
- **Order by urgency, then age.** Show when each was raised. Do not reshuffle while the reader is reading.
- **Each item has an exit**: answer, approve, dismiss, hand over. Say what happens next, and remove it
  when it is done.
- **The count is honest.** A badge counts items that need action, and matches the list.
- **Empty is the goal.** Say "Nothing needs you" plainly, with when that was last checked.
- **Cap it on overview pages**: the top few, with the total and a link to the rest.

## Actions

- **Put the action beside the thing it acts on**, labelled with a verb and an object: "Pause seat",
  not "OK" or an unlabelled icon.
- **Acknowledge at once, confirm when true.** On click, show that the request was sent. Change the state
  only when the system confirms it. If you show the new state early, mark it as pending and put it back
  if the request fails, with the reason.
- **A disabled control says why**, and what would make it available.
- **Confirm only what is hard to undo**, and make the confirmation specific: name the thing and the
  consequence. Offer undo for everything else in place of a confirmation.
- **Guard against the double click and the stale page.** An action taken on old state should be refused
  with an explanation, not applied to something that has since changed.
- **Leave a trace.** Who did what, to what, when, and whether it worked, visible near the thing and in a
  log.
- **Bulk actions** show how many things they will touch, before they touch them.
- **Dangerous and routine actions do not sit side by side** looking the same.

## Forms for work over time

Charts of figures are in [chart-selection](chart-selection.md). Consoles also need these.

| Form | Use it for | Rules |
| --- | --- | --- |
| **Activity lanes** (one row per worker, time across) | Who was doing what, when; gaps and overlaps | All lanes share one clock; now is marked; states use the page's status colours; a lane's label opens that worker |
| **Event log or stream** | What happened, in order | One line per event: time, who, what, to what; newest position consistent; filter by source and severity; repeats grouped with a count; each line links to its subject |
| **Board** (columns are stages) | Work moving through a process | Stages in order, count in each header, each column scrolls by itself; cards show only what decides the next move; mark cards that are stuck |
| **Node and link map** | Dependencies; what flows where | Only when the structure is the question; keep positions stable between refreshes; labels readable without hover; offer a list of the same data |
| **Progress** | A known amount of work | Done of total, with units; a rate or time left only if it is reliable; an indeterminate indicator when the total is unknown |

## Noise

Attention is the scarce resource. Guidance from control-room design is blunt about it: screens stay
grey and calm in normal running, colour is kept for the abnormal, and an operator can absorb only a
handful of alerts an hour before they start ignoring them.

- **An alert is something a person must act on.** Everything else is a log line.
- **Threshold plus duration.** Raise it when the condition has held long enough to matter; clear it only
  after it has stayed clear, so a value hovering at the line does not flap.
- **Group repeats.** The fortieth identical event is a counter on the first, not forty rows.
- **Tie causes together.** If one failure produces ten symptoms, show the one with the ten beneath it.
- **Few priority levels**, most alerts at the lowest. If everything is urgent, nothing is.
- **Measure it.** Count the alerts raised per day and how many led to an action. Remove or retune the
  ones that never do.

## Reading while it changes

- New items arrive without moving what the reader is looking at. Show "3 new" and let the reader bring
  them in.
- Hold a stream still while the pointer or focus is in it.
- Text the reader is typing survives every refresh, reconnect and navigation away and back.
- Mark what changed since the reader last looked, briefly, then let it settle.
- If the connection drops, say so at once and show the age of what is on screen. Disable actions that
  cannot work, with the reason.

## Text from people and machines

Much of a console is words: messages, titles, reasons, output.

- **Summary first**: one line saying what happened, in the reader's terms; full text one step away.
- Format long text for reading: paragraphs, lists, code as code. Never a wall of escaped characters.
- Trim machine output to the lines that matter and link to the rest.
- Raw identifiers, hashes and timestamps are for copying, not reading. Show a name, and keep the
  identifier within reach.

## Finding your way around

- **Each thing has one name, one colour or mark, and one home page**, the same wherever it appears.
- Overview, then the thing, then its detail: every level reachable by link, every page with an address
  that can be bookmarked and shared.
- **A side panel for a quick look, a page for work.** A panel keeps the reader's place in the list
  behind it; closing it returns them exactly there.
- Going back restores filters, scroll position and selection.
- Search or a jump-to control once there are more things than fit on a screen.

## Extra review checks

- [ ] Stop the source of data. Does the page show the things as silent, or still as running?
- [ ] Every state in the vocabulary has been seen on screen, including unknown.
- [ ] Every item in the attention queue is one this reader can act on now.
- [ ] Each action shows sent, confirmed and failed; a failed action leaves the state unchanged.
- [ ] A burst of fifty identical events produces one grouped row.
- [ ] New data arriving does not move the row under the pointer or lose typed text.
- [ ] From any name on the page, one click reaches that thing.
