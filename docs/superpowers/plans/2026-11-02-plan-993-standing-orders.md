# Plan: saved orders and seat instructions (#993, including #763)

Draft for controller review. Source baseline: `f7ee4e26`, 2 November 2026.
This document plans delivery; it does not authorise a crew start or a live provider check.

## Outcome and split

The operator saves global standing orders for FLIGHT and dated instructions for named seats.
FLIGHT can save seat instructions, but cannot change the operator's entries.
Active orders accompany every FLIGHT wake. Each resulting re-plan names its saved order.
Revoked entries remain readable, including from old decisions.

Closed #763 belongs in this parent. Its 31 October folding comments are requirements, not delivery evidence.
Keep #993 as the parent, with two build children:

1. Server/core/runtime, Size L, `area:server`, with explicit core and role Paths.
2. Web, Size M, `area:web`, depending on the server child's issue number.

Draft bodies are adjacent: `2026-11-02-993-server-brief.md`, `2026-11-02-993-web-brief.md`
and `2026-11-02-993-parent-body-proposal.md`. Replace the web dependency token before filing.
Each brief is self-contained. Do not file a duplicate #763 or call repo memory standing orders.

## Evidence and existing seams

| Evidence at the baseline | Consequence |
| --- | --- |
| `apps/web/src/flight/KnowsTab.tsx:5–23`; `apps/web/test/Flight.test.tsx:1484–1489` | Both features explicitly remain unavailable. |
| `apps/server/src/store.ts:549–552`; `flight/tools.ts:3040–3083` | Memory is mutable topic storage. Reuse author-protection principles, not the memory schema. |
| `flight/state.ts:1315–1356` | Memory is diffed and capped. Orders need a separate, complete, every-wake envelope. |
| `flight/watch.ts:452–470`, `600–612`; `packages/core/src/flight.ts:1306–1319` | Initial, rotated and repeated wakes meet here. |
| `runtime/supervisor.ts:1332–1343`, `1670–1730`, `3689–3701`, `4487–4534` | Final provider delivery and verified base docs are runtime integration points. |
| `runtime/brief.ts:470–483` | Repo CLAUDE.md and AGENTS.md already have an ordered prompt builder. |
| `packages/core/src/flight.ts:51–85`; `flight/tools.ts:483–489`, `1131` | No re-plan kind/reference exists; log_decision currently writes note. |
| `api.ts:1246–1296`, `2574`, `5688`; `flight/operator-call.ts:19–28` | Preserve validated declared actor provenance across lifecycle changes. |
| `agent/SideTabs.tsx:90–232`; `api.ts:3889–3917`; `seat-focus.ts:6–29` | Focus already has UI and persistent config writes. Preserve its behavior. |
| `flight/tools.ts:1537–1553`; `config-write.ts:539–546`; `crew-apply.ts:117–119` | Legacy FLIGHT focus writes and config reloads must use the same effective instruction model. |
| `focus.ts:4–27`; `engine/queue.ts:332`, `431`, `512`, `586` | Keep the selector grammar and all queue eligibility checks unchanged. |

Paths without a prefix in this table are under `apps/server/src`, except `agent/SideTabs.tsx`
under `apps/web/src`. Source line numbers identify this baseline, not a future branch.
The runtime references direction.md in role text but does not inject its file contents today.

## Proposed shared contract

These names are a concrete proposal. A builder can adjust names while preserving the behavior and wire compatibility.

Use one `standing_instructions` table in `store.ts`:

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
seat_id TEXT,                 -- NULL = global operator order for FLIGHT
kind TEXT NOT NULL,           -- text | focus
text TEXT,                    -- focus NULL = an explicit clear
by TEXT NOT NULL,             -- operator | flight; authority, never a client-supplied field
at INTEGER NOT NULL,
revoked_at INTEGER,
source TEXT NOT NULL DEFAULT 'saved' -- saved | legacy-config
```

Validate the discriminated shape in core/server. A global entry must be text, nonempty, and operator-authored.
A seat text entry is nonempty. Seat focus uses the existing `seatFocus` schema, including null.
Author, ID and dates are server-assigned. `source=legacy-config` identifies imports without claiming historical human authorship.
No repo restriction is added to global orders. Seat resolution and tool authority follow existing configured-seat/session rules.
Do not introduce a new cross-repo permission restriction under #1214.

Core exports `StandingInstruction`, `StandingInstructionInput` and list/mutation response types.
The public row includes ID, target, kind, text/focus value, by, at, revokedAt and source.
List responses include `{active, history, nextCursor, effectiveFocus?}`. Active entries are complete;
only revoked history is paginated, newest first, 50 rows by default and 100 maximum.

Proposed APIs:

| Method and path | Body/result |
| --- | --- |
| `GET /api/flight/orders?before=<id>&limit=50` | Complete active global orders and paginated revoked history. |
| `GET /api/flight/orders/:id` | One retained global order, including its revoked state; supports old decision links. |
| `POST /api/flight/orders` | `{text}`; returns the saved row. |
| `POST /api/flight/orders/:id/revoke` | `{}`; returns the retained row. |
| `GET /api/seats/:id/instructions?before=<id>&limit=50` | Seat rows plus effective focus and its source ID. |
| `GET /api/flight/instructions` | Page-shaped active seat instruction index, grouped by configured seat, with effective focus. |
| `POST /api/seats/:id/instructions` | `{kind:"text",text}` or `{kind:"focus",focus:string|null}`. |
| `POST /api/seats/:id/instructions/:instructionId/revoke` | `{}`; target must match the stored row. |

Revoke is idempotent: a repeat returns the original revokedAt and adds no second audit or notice.
Unknown IDs/targets return 404; malformed inputs 400; protected writes 403; capacity/conflicts 409.
Display/edit means append a replacement and revoke the old row in one transaction.
An optional `replacesId` on creation provides this operation with target/author checks.
Do not mutate existing text or backdate an edit.

Proposed implementation bounds: 4,000 UTF-16 code units per plain text entry, 64 active entries per target,
and 64 KiB of fully rendered active instruction content per target. These are new bounds for this feature,
not existing standing-order limits. The 4,000 value follows existing memory/decision text bounds
(`packages/core/src/flight.ts:199,366`); the active-count and aggregate-byte bounds are new proposals.
Existing focus retains its 500-character validator (`apps/server/src/focus.ts:11`).
Validate trimmed nonempty plain text and check capacity inside the write transaction;
reject an oversized change before saving, with a useful error. Never silently trim, omit or evict an accepted entry.
Retain revoked history outside ordinary memory/decision pruning.

## Authority and lifecycle

Use the existing operator token and common actor validation. Reject caller-supplied by/at/revokedAt fields.
Instruction HTTP mutations require a configured matching operator token; missing token configuration is not anonymous write authority.
Once the common hook validates `x-mc-flight-actor`, its presence is declared FLIGHT provenance.
Protected route handlers must test header presence, not repeat `flightActor(req)` after body parsing or awaiting work.
A run ending during parsing cannot turn a FLIGHT request into an operator request.
Malformed, stale-at-entry or mismatched actors stay refused by common validation.

Global order creation/replacement/revocation accepts authenticated operator provenance only.
Seat entries from declared FLIGHT provenance are authored as FLIGHT. They can never replace or revoke operator entries.
Seat bearer tokens do not acquire operator authority by reaching HTTP routes.
Add no global-order write tool, and keep global writes outside `mc operator`'s allowed route catalogue.
Only new seat tools are `instruct_seat` and `revoke_instruction`; their arguments use existing
FLIGHT authentication and target resolution, with a basis. An operator may revoke either author's seat entry.

Record successful FLIGHT instruction mutations as a visible `instruction` decision, with entry ID,
seat, kind, action and basis. Use the existing audit/runaway wrapper once per real mutation.
Persist a change notice through the existing `sendComms`/`supervisor.message` path used by message_seat.
For a live seat, notify without stopping or un-parking it. A busy seat receives the notice through its inbox.
Return saved/delivery status honestly; a delivery failure does not delete the saved instruction or duplicate it on retry.
The Comms notice contains a short ID/action reference within its existing message limit.
At provider delivery, append the complete current seat-instruction snapshot, including explicit replacement/revocation state.
It supersedes the older saved snapshot. Do not squeeze a 4,000-character instruction into a truncated Comms message.
No active provider or seat is needed to prove this with fixtures.

The operator token is also held by full-access FLIGHT. These checks protect supported workflows;
same-user writable shell access remains the accepted #1214 boundary, not an OS isolation guarantee.
Orders and instructions cannot bypass hard-rule clearance, budgets, approvals or repository floors.

## Focus compatibility and precedence

Keep `focus.ts` and `matchesFocus` selector semantics. Reuse the current Queue focus form and API.
The shared instruction service becomes the authority for the effective value; all queue checks,
GET focus, `message_seat read_focus`, Agent and FLIGHT read the same resolved result.

Migration imports an explicitly configured focus, including null, once per seat as an
operator-controlled `source=legacy-config` row. Its timestamp is import time. Show "Imported from config",
not an invented original author/date. Record the last observed raw config focus separately using existing settings.
Afterward, an explicit config focus change on reload creates a new operator-controlled replacement.
An omitted focus preserved by the session editor is not a change. Deleting a previously present raw
focus field is an explicit clear; importing it creates a null row. Do not import projected runtime values as config edits.

Resolve active focus as the newest operator row, otherwise the newest FLIGHT row, otherwise null.
Within an authority, replacing focus revokes its previous active focus row transactionally.
An active operator null is an explicit clear and outranks FLIGHT; it is not an absent row.
Revoking an operator focus may expose an active FLIGHT focus. Return the resulting effective value and source.
Show that effect before revocation in the UI. FLIGHT focus writes while operator focus is active
return a clear conflict rather than silently superseding or queuing an invisible lower-priority filter.

Route legacy `POST /api/seats/:id/focus` and `message_seat {focus}` through this same service.
Operator Clear replaces focus with an active null row, preserving today's unrestricted-selection result.
FLIGHT Clear is a FLIGHT null row and cannot clear an operator filter. Preserve GET's `{focus}` shape;
additional source metadata is additive. Keep direct config changes compatible through the import path.
Apply the effective value consistently at queue eligibility and last-moment start checks.
Do not add a second selector grammar, a new focus form, or a separate unprotected config-write bypass.

## Delivery, direction and prompt precedence

Use a shared final-delivery envelope for FLIGHT's initial, repeated, rotated and resumed wakes.
Include operator-message wakes too. Read current active orders at actual queued delivery time;
an order revoked while delivery waits must not reappear from an earlier prepared digest.

Envelope order: hub identity/safety guidance; verified repo direction; complete active global orders;
seat instructions if applicable; then the existing wake/working context/memory.
Keep entries in saved-time/ID order and include their IDs, authors and dates. Preserve conflicting text;
FLIGHT follows the operator's stated precedence or asks through the existing brief flow when that is unclear.
State explicitly: global operator orders outrank memory and seat instructions; operator seat instructions
outrank FLIGHT seat instructions. Repo rules and safety floors remain binding.
Preserve original message origin and content inside the envelope, plus existing inbox acknowledgement and replay keys.

Read `docs/direction.md` with verified Git objects at the watch checkout's selected base, alongside current repo-doc loading.
Persist `{sha,text}` as run-scoped direction context so restart/resume can reproduce it.
An absent direction file has an explicit absent marker. A proposed 64 KiB direction bound follows
the existing repo-doc budget (`runtime/brief.ts:37`), but is new for direction-file injection.
A symlink, invalid object, or direction file above that proposed bound
is an explicit delivery/setup error, not a silently truncated direction. Surface the error with recovery steps.
On a fresh or rotated watch session, load its selected current base. On resume, use the retained source;
if missing, rebuild from a verified base and label that source. Do not read agent-editable worktree text as trusted direction.

For non-watch seats, append current effective seat instructions after the existing CLAUDE.md/AGENTS.md blocks.
Refresh them on start/resume and use the durable change notice for an already-running seat.
Do not depend on rewriting an already-started provider system prompt to deliver live changes.

Add instruction revision/IDs to `wakeFacts`, pending-change handling and change-bus invalidation.
A new order or revocation wakes FLIGHT even when no ticket changed. Advance delivered revision only after send succeeds.
After that delivery, unchanged orders remain in every envelope without creating a constant wake loop.
Update prompt section accounting for direction, orders and lessons; its "orders" metric must not hide omitted text.

## Re-plan evidence

Extend `log_decision` additively: existing calls default to `kind:"note"`;
`{kind:"re-plan",orderId,about,decision,basis}` requires a valid saved global order ID.
Retain `order_id` on the stored decision and expose optional `orderId` in the read type.
Carry it through decision mappers, recent state and wake/read models, not only the SQL row.
Permit a historical reference after revocation, label its state, and reject missing/non-order IDs.
Add `re-plan` and `instruction` to the shared decision kinds and web labels.
The role tells FLIGHT to name what changed: promotions, holds, splits or pick order.
No change requires no fabricated re-plan. Multiple causal orders can receive separate linked decisions.
The prompt requirement guides judgments; this slice does not build a natural-language scheduling rule engine.

## Build order and meaningful checks

1. Add shared shapes, persistence, complete active reads, retained history and transactional mutations.
   Prove import/restart, capacity rejection, idempotence, replacements and focus resolution.
2. Add authenticated APIs and instruction tools. Prove provenance/refusal without mutation, audit or notice.
   Include encoded paths and the actor-run-ended-during-body-parsing regression from #1376.
3. Integrate final provider delivery, verified direction, wake revisions and seat prompts/notices.
   Prove initial/repeated/rotated/resumed/operator-message envelopes with fake CLIs/transports.
   Exercise orders changed while queued, delivery failures and restart restoration.
4. Add typed re-plan references and role wording. Prove persistence, validation and revoked-history lookup.
5. Build the web child on the merged contract. Mock up a major layout change before building it;
   a focused replacement of existing panels can preserve the current hierarchy.
6. Exercise real production components against API fixtures, then retain reviewed-head evidence.

Server test locations: `apps/server/test/store.test.ts`, `api.test.ts`, `flight-tools.test.ts`,
`flight-wake.test.ts`, `flight-watch.test.ts`, `brief.test.ts`, `supervisor-start.test.ts`,
`supervisor-events.test.ts`, `supervisor-restart.test.ts`, plus current focus/queue/config tests.
The existing queue/config suites are `queue.test.ts`, `config.test.ts` and `config-write.test.ts`.
New focused `standing-instructions.test.ts` and `standing-instructions-api.test.ts` are appropriate.
Core shape/decision checks belong in `packages/core/test/flight.test.ts` and focused new tests if needed.
Web checks extend `Flight.test.tsx`, current Agent tests and `flightConversation.test.ts`.

During implementation run lint, typecheck and `pnpm -s test:related` on the final head, with focused
Vitest files while developing. CI supplies its normal full checks. A controller PR follows the
repo's existing full-test/build rules; this plan does not add another repeated-suite gate.
For this docs-only draft: `git diff --check`, body-size/dependency-token checks and path checks only.

## Automated evidence versus provider observation

Automated acceptance proves exact prompt delivery to fake provider boundaries, persistence, protected mutations,
focus selection, audit references and UI behavior. It cannot prove every future model follows natural-language orders.
An actual-provider example can later show a saved order causing a real re-plan when authorised crew work resumes.
Record its order ID, wake/run, model response and decision honestly. It is not an added live acceptance gate.
Keep the standing paid crew idle for this refinement and its test fixtures.

## Overlap and sequence

All 14 current open issues were checked: #1362, #1361, #1360, #1214, #1196, #1178,
#993, #933, #925, #759, #715, #677, #656 and #45.
#993 owns the feature; #677 names it as outstanding. #759 owns complete briefs, not durable orders.
#1214 supplies existing access/provenance; preserve its authority rather than adding cross-repo restrictions.
#715 is loop configuration; no dependency is needed for prompt guidance.
#925 owns accountable QA reports; use its existing report/evidence readers rather than creating another QA system.
#1361 owns Agent layout and #1362 owns shared form styling. Coordinate or sequence overlapping files;
consume their shared patterns instead of rebuilding them. Add an issue dependency only if the web patch actually
requires an unmerged contract from those tickets. Overview #1360 and PR #1374 remain separate and take priority.
No open PR implements orders or instructions; the only open PR at audit time was #1374.

## Review and remaining decisions

No product decision is required for the basic contract above. Global orders avoid invented repo scoping.
Use the existing hard-rule review and independent current-head controller checks for changes to FLIGHT's own authority.
A major web redesign gets a mockup first, offered to the operator with a recommendation
(`docs/direction.md:25`, `roles/FLIGHT.md:85`). These sources add no mandatory approval wait.
Do not create another product approval or live-check gate.
This draft does not claim any implementation, test pass, provider observation, merge or deployment.
