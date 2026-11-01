# Desktop density plan for operator approval

Stage 2 of #1193, following the [desktop research](2026-11-01-hud-density.md) and its 240-image gallery in PR #1341. The operator saw the report before this proposal. This plan has not been approved. 

Plan approval permits the mockup stage. The mockup then needs separate approval before build tickets.

## The decision

Use one compact **layout below 2200 CSS pixels**, with the current comfortable layout at wider desktop sizes. Do not add a preference switch in this work. At 1920×1080 and 1×, the layout should use less panel chrome and allocate more room to the current work. It should not reduce all text sizes. This is a proposed application of the research, not a claim about a vendor's deployed pixels.

Keep the published type scale: title 20/28, panel title 14/20, body 13/20, secondary 12/16, mono micro labels 11/16. Repair Comms' 10.8333 px regular small text to 12/16. Repair panel headings using 13/20 to the 14/20 token. Use only existing 4/8/12/16/24/32/48 spacing tokens. Gutters remain 24 px from 1600 upwards and 16 below 1600; fix the current 12 px shell gutter explicitly rather than preserving a second scale.

Compact tables use 32 px rows and comfortable tables use 40 px rows, as the design system already allows. Compact panel headers use 8 px vertical and 16 px horizontal padding; content padding stays 16 px. Form controls remain at least 32 px high, with 13/20 input text. All interactive targets, including links, checkboxes' labels and icon buttons, must be at least 24×24 px. Wider displays gain useful comparison space, not larger versions of the same sparse form.

The breakpoint changes layout and row geometry. It does not change a measure's meaning, hide a critical state or introduce a second body-font scale. Shorter windows scroll visibly; panels do not clip to preserve an arbitrary one-screen claim.

## FLIGHT's default space

Below 2200 px, start the site-wide dock as a **48 px rail**. It shows a named FLIGHT control and the count of items waiting for the operator, with a word/shape and accessible full label. The Overview's Needs-you summary remains visible in the main area. A new item updates the count; it does not repeatedly open a dock the operator closed.

Opening FLIGHT expands the existing 380 px column. Its first screenful contains a short current headline, the three highest-priority waiting items with their reasons, and the next useful action. Empty states name what is absent. A quiet dock never reserves 380 px merely to show a waiting count and Expand/Hide. Above 2200 px the column may start open, with the same useful content and an obvious collapse control. Preserve the operator's open/closed choice within the browser session.

The rail control, expanded panel and page content have a predictable focus path. Expanding transfers focus to the dock heading or requested action; collapsing returns it to the rail. The count and state are not conveyed by colour alone. Changing dock width must not reset an unsent draft or the selected ticket.

## Overview and Agent

Overview answers **what needs attention, what is running, and what should happen next?** At 1920×1080, propose a 96 px KPI strip instead of the earlier 135 px tiles. Keep labelled values and meaningful windows; a missing series gets a named collection state, not an empty sparkline. Timeline lanes use labelled spans/events on a shared time axis. Marks distinguish duration from an instantaneous event; the current “tadpole” appearance is not a new metric.

Allocate enough height for the copied sample's eleven crew rows at 32 px, plus table/panel headings. A target crew-panel height near 432 px is a mockup allocation to verify, not an unconditional fixed-height rule. With more seats, use a clearly scrollable list and retain headings. Do not silently hide rows or shrink their text. Align Machine labels, units, chart baselines and windows. The pipeline becomes a compact lane summary: ticket number, short title where useful and assignee, with a Board drill-through. A quiet lane does not require a large empty card.

Prefer short state words, usually 5–10 characters where meaning permits. Preserve familiar concise states such as Idle. Show the specific reason adjacent to the selected row or in accessible detail; never discard a held reason to shorten the pill. Agent keeps the approved v2 question/result, review, context and history hierarchy. The reclaimed dock width gives those sections room; it does not move the answer below a new wall of metadata. Long asks/results wrap, and history remains lazy.

## Form rules and complete inventory

Labels sit above fields, persist after typing and use the same wording as validation. A short hint follows the label; an error sits beneath its field. Group related inputs with a 16 px gap and sections with 24 px. Use one column for the main sequence; two columns are for genuinely related short fields, not a way to fill the screen. Narrow record forms have a maximum width near 480 px, grouped editors 640 px and multi-step repo configuration 800 px. These are proposed field-purpose bounds, constrained by the viewport, not new spacing tokens.

Put the primary action and Cancel together after the last field. Their placement stays stable while validating. On submit, focus an error summary and link it to invalid fields; retain entered values on server failure. Pending submission names the operation and prevents duplicate writes. Empty/loading/error/stale/disconnected states name what happened and how to recover. A multiline help block longer than four lines moves to an expandable detail section.

| Opened surface from the research inventory | Layout and grouping | Primary action and validation |
| --- | --- | --- |
| Add/edit agent | 480 px; identity, role and account together; area/repo scope in a second group | Add agent / Save agent; validate unique id and compatible role/account beside fields |
| Add session | 640 px; session identity then repo/checkout assignment | Add session; preserve selections if the server refuses the checkout |
| Account add/edit | 640 px; vendor/account identity, then authentication guidance | Add account / Save account; credentials never become sample text or visible error echoes |
| Agent account switch | 480 px; current account above compatible alternatives | Switch account; show the selected account and any effect before submission |
| Repo onboarding: identity | 800 px stepper; GitHub identity and project fields together | Next: checkout; validate owner/repo and project separately |
| Repo onboarding: checkout | Same stepper; path and clone/existing-checkout choice | Next: live checks; keep path errors beside the path |
| Repo onboarding: checks | Same stepper; each check has a named pending/pass/fail result | Continue only when the required checks permit it; no spinner-only result |
| Repo onboarding: mode/account | Same stepper; available-work rules, mode and account are grouped by purpose | Add repo; give the final scope summary before a write |
| Repo seat add/edit | 640 px; seat identity, role, account and selection rules | Add seat / Save seat; distinguish incompatible role from invalid id |
| Board configuration | 800 px; labels, priority, assignee and milestone filters in named groups | Save board configuration; show effective selection and field-specific errors |
| Template editor | 800 px; identity, ordered steps/decisions and step details | Save template; a step error points to the corresponding step, not a generic footer |
| Teams/source selection | 640 px; source identity and selected channels in separate sections | Save sources; keep selected channels visible after failed loading or submission |
| Crew pause: all/selected | 640 px; scope first, then reason and duration | Pause crew / Save pause; selected-seat summary stays visible and validates empty selection |
| Away | 480 px; mode and return/review condition | Save away mode; distinguish invalid date from a disconnected hub |
| Quiet/expanded FLIGHT composer | Expanded dock width; named recipient/context above the draft | Send; retain draft across collapse, errors and disconnection |
| Agent conversation | Use the existing result width; composer follows current context | Send; show whether a reply or new message is being sent |
| Attention discussion | 640 px readable column; item reason above discussion | Send; retain item identity while the list changes |
| Comms conversation | Readable conversation column with distinct agent chatter sections | Send; focus returns to the composer without losing scroll position |
| Queue focus | 480 px; current focus above the proposed replacement | Save focus; name the affected seat and scope |
| Memory add/edit | 640 px; repo, topic and note body grouped in that order | Add note / Save note; retain note text on rejection |
| Hold: manual/date/ticket | 640 px; condition selector reveals one matching field group | Hold item; only relevant fields validate, and hidden errors cannot block a new condition |
| Agent rename | 480 px inline editor, beside the current name | Save name; validate trimmed content and keep the current name on failure |
| QA question | Detail-column width; PR/head context above the composer | Ask QA; retain draft if the head changes or send fails |
| QA send-back | 640 px within PR detail; reason and exact-head context | Send back; require a trimmed reason and refuse a moved head with a recovery action |
| Brief/update log/help/command palette | Named dialogs with bounded readable content, visible scroll and a close control | Preserve keyboard navigation and restore focus; no form-style Save for a read-only dialog |

These rules specify the inventoried surfaces, not successful save behavior already proved by screenshots. Implementation checks must exercise permissions, persistence and failure recovery separately.

## Other pages and the folded behavior fixes

Apply the same shell, type, row and form rules to Board, Comms, Map, Telemetry, Audit and every Setup section. Preserve Map's lazy loading and keyed graph reads. Comms' graph must retain cross-agent selections and make actual chatter visible. Telemetry charts require comparison with their source arithmetic before an accuracy claim; changing density alone does not prove them correct. Audit uses the separately approved #1185 code-health design, rather than inventing another density-only list layout.

The four behavior gaps folded into #1193 remain explicit build outcomes: preserve the held state's reason in accessible detail; show a paused/stopped review seat's oldest queued review instead of Idle; exclude superseded-head reports when the current PR head is known; and keep Board card props primitive so five-second clocks do not re-render unchanged cards. A clock child mounts only when a check actually needs it. Split server and web changes into their own scoped tickets with dependencies.

## Mockup and approval checks

After plan approval, mock up Overview, Agent and one representative grouped form. Use 1920×1080 and 2560×1440, both themes, at 1×. Include the rail, expanded dock, eleven-row crew fixture and empty/long form cases.

Also check 1280, 1600 and 1600×700. Render 1440×900 before showing the work. Record type, targets, clipping, scroll, focus, validation and disconnection checks. Use fictional content; real identities, machine paths and other-project references stay private.

The operator then approves that mockup before build tickets. #677 also requires its remaining per-page mockups under `docs/mockups/2026-10/` and their own approvals; these three density screens do not satisfy the whole site-review ticket. File no product build ticket from this proposal before the required approval. No crew, schedule or product setting changes in this stage.
