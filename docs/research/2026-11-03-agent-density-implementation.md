# Agent density implementation · #1361

Baseline: `6f0df12e1112ace4bae4fa869117b3464e58f4a7`. Delivered formatter main
`99e8404ea2e78e442dee828092f6b997582ddbe7` was integrated before the source checkpoint.
Approved reference: PR #1353,
`ace336c3209af1fd0fd7a20bd5423f8f8886159a`,
[`agent-density.html`](../mockups/2026-10/agent-density.html).

The reference supplies the hierarchy and spacing direction. Its example measurements are fictional;
the Agent page continues to use the existing AgentDetail/CrewRow responses.

| Existing content or action | Proposed placement and retained meaning |
| --- | --- |
| Picker, seat identity, state/reason, ticket, branch, account/model/CLI/area | Compact identity before the answer. Retain every selector button in a bounded picker with an actual-overflow count cue and keyboard scrolling. Keep full reasons available. |
| Ask, acceptance checks, reported result, met/unmet evidence and remaining work | First primary panel, ahead of run figures and loop steps. Long text wraps or has an explicit full-text control. Reported acceptance remains labelled as reported. |
| Server-owned next move, recommendation and route | Immediately after ask/result. Preserve the named owner and real destination. |
| PR/file/screenshot deliverables | Primary evidence list, with all links retained and a named keyboard-scrollable region for long lists. |
| Transcript, composer, interrupt/send, draft/pending/error handling | Primary conversation panel, same keyed component and permission behavior. |
| Awaiting reason, stopped/paused availability, source error | Secondary current-state panel. Availability does not erase queued work. |
| Oldest queued current-head review and executing review | Show their distinct server-provided SHA/ref, queue reason/position and evidence route. A paused executing assignment is labelled assigned rather than active checking. |
| Health, tool calls/failures/by-tool detail, token input/output, cost/mean/turns, current context/window | Retain all five factual cards in secondary context. Unknowns remain distinct from measured zero. Context includes the available used-token count. |
| Complete configured loop steps, tries/failures/limits, reasons and measured duration/live age | Secondary build-loop panel, with the existing run-trace route. No omitted steps. |
| Current handoff, related reviews/subagents/set-aside runs, prompt sections/compactions, Plan/Queue/Files/Context tabs | Secondary panels. Keep all existing forms, selection and lazy tab reads. |
| Attempts and previous runs | Existing disclosure with the same lazy reader. No eager history or PR-list join. |
| Account switch, seat settings, rename/remove, interrupt/end/hold, popout | Existing header controls and lazy forms; retain confirmation, permission, pending/error behavior and focus. |

## Review and model facts

AgentDetail already filters blocking findings to the current PR head server-side and supplies saved
evidence links. It does **not** supply a writer PR head SHA, CI check totals or review-round total.
Those cannot be copied from the mockup or inferred from an older run. The existing “not recorded”
states remain; the executing and queued review SHAs are shown only where those fields exist.

Effort and budget use `row.cli.effort` and `row.cli.budgetUsd` only when present. An unset effort no
longer becomes an invented “default”; a real zero budget remains a recorded zero.

Board, Agent review status and the actual shared PrChip use the same current-head vocabulary.
Held reasons have a keyboard control, not just a hover title. Only the checking-age child reads the
five-second clock; unchanged cards and PR chips without an elapsed check do not subscribe to it.

## Author verification and remaining review

The [source-bound gallery](../evidence/agent-density-1361/README.md) retains all64 matched pairs
and eight after-only keyboard/full-content proofs at source `746430541045d52a41cf350e50544615254293bc`.
It covers the required widths, both rail states/themes, short height and empty/one/50/long/state
cases, with real production fonts and settled controlled API values. Its per-surface observations
record column allocation, text wrapping, scrolling, actions and retained drafts. Earlier genuine
reader/title defects, failed experiments and fixture mistakes are retained separately.

Selected units passed in two earlier stages (488 +240 distinct cases); source746 passed20 browser
cases plus web types, lint and build. Fresh independent whole-branch review of artifact624 found
one Minor: narrow long previews exceeded four lines. Source `beb6e04421bc44502b9966d380dc15c9a14edd6a`
measures actual visual overflow and preserves full readers even below the character limits.
Its193 affected units, web types and two targeted browser cases passed. The same reviewer passed
the correction and rendered design at3November10:09:07UTC. The required1440×900 both-theme/rail
supplement is retained separately; the earlier1440×1000 images keep their actual dimensions.

The gallery preserves these separate source phases and the original Minor evidence. Final artifact
verification and exact-head CI remain required before delivery; no CI or live-data pass is claimed.
