# Draft child: Complete operator briefs open inline with bound Accept and Discuss

Publication status: PRIVATE DRAFT for controller review. No issue number, implementation or approval is claimed.

Parent: #759. Priority: P1. Size: M. Area: web. Owner: web implementer.
Source baseline: `9981a828cfd0ebcf480a08b767905d1a138a4c8a` (3 November 2026).
Depends on: the server child, “Server enforces complete operator briefs and bound, authorized choices”.
Replace this title reference with its actual issue/PR when the controller publishes it. Consume its
merged contract; do not invent local authority/freshness or build on an unmerged dependency.

## Outcome

Opening FLIGHT's Needs-you home shows a complete decision brief without opening another panel.
Question, why-you, context, consultations, all options/consequences/reversibility, recommendation,
no-answer timing/hold condition, delay cost and freshness are visible. Accept recommendation is
the primary bound action. Discuss uses the existing correlated conversation inline.

The same complete brief and choice behavior is shared by Needs-you, Comms and the item panel.
An operator decision never shows an automatic approval countdown. An authorized reversible FYI
shows the server's planned effect and 40-minute deadline; the client cannot create that capability.

## Why / current baseline

AskedOfYou's ordinary rows open FullBrief, but ItemBrief lacks the complete decision contract and
does not show the option comparison/actions there. Person cards require another click. Comms has
Accept, Discuss and Held; its generic message action differs from ItemPanel's FLIGHT choice, which
currently sends through chat-only discussion. The server child supplies the bound choice contract.
Do not preserve that mismatch or make chat text execute an option.

#1378's Agent/Crew/Knows instruction UI is delivered on main9981. Preserve it, current FLIGHT tabs,
Needs-you counting/session behavior, shell/dock, memory and QA surfaces. This is a local brief/card
enhancement, not an Overview, inbox or whole-FLIGHT redesign.

## Design contract

Task: identify the decision, compare its actual consequences, accept the recommendation or discuss
it without hunting through panels. Normal data is one open ask with two options; also exercise four
options and three ordinary asks. Fifty asks and 8,000-character fields are stress states, not the
normal composition reference.

Read .claude/skills/hud-design/SKILL.md, docs/design/system.md, docs/runbooks/visual-qa.md and
table-qa.md where a comparison table is used. Reuse current HUD tokens and controls. Preserve the
old docs/mockups/complete-brief-759 draft as historical proposal evidence; its fallback-font/static
renders are not implementation acceptance. The requested panel enhancement needs no extra design
approval wait. If implementation expands into a major page redesign, prepare a native proposal first.

| Surface | Essential content / normal size budget | Long content and retained behavior |
| --- | --- | --- |
| Needs-you brief card | Fill the existing primary panel's usable width; align identity, question, reason and recommendation at the start. Normal prose prefers 640–800px readable measure and may use up to 960px when useful. Keep metadata/actions grouped with their own brief. Use normal content height rather than equal-height tiles or a fixed 260px answer viewport. | Do not collapse required fields or move them into the flyout. Long content has explicit vertical access; no hidden/clipped field or tooltip-only value. Following panels can move down within the existing page flow. |
| Option comparison | 2–4 rows; each contains option label/ID, recommended marker, consequence and reversibility words. If tabular, budget roughly 160–200px identity, flexible consequence and 180–240px reversibility; allow wrapping. | At constrained usable widths, stack labelled fields within each option instead of squeezing columns. Preserve complete content and action target. Do not use an unexplained ellipsis or horizontal page overflow. |
| Actions and timing | Named primary action with the actual effect; Discuss and existing hold controls adjacent. Operator asks say they wait; FYIs show the server deadline/effect. | 24×24px minimum, standard 32px controls where applicable, visible focus. Scrolling/focus must reveal the final action without an overlay covering it. No sticky control may obscure text. |
| Inline discussion | Existing item conversation beside/below its complete brief, mounted on demand; keep current source identity visible. | Preserve per-item/thread drafts, message IDs/history, errors and focus return. Chat never chooses an option. |

At CSS 1280/1600/1920 widths and 1600×700, both themes, keep the same decision hierarchy and
current dock behavior. Test folded and expanded dock where it reduces the affected content width.
This local change does not promise a new 4K dashboard composition. Record actual CSS viewport,
DPR/zoom/rail, fixture clock, source/base and capture region. Test meaningful text enlargement/reflow
for the new card rather than treating DPR2 as browser zoom.

## Shared rendering and action behavior

- Render the server's versioned content/completeness, source identity/freshness/reason, timing,
  available typed action label and current receipt. Do not derive eligibility from prose, item kind,
  option label or absence of a protected flag.
- Show every required field on initial brief opening, including consultations=[] as “Nobody
  consulted” and honest unknown delay costs. Source evidence and who was consulted are distinct.
- A normal brief should read as one coherent decision, not a collection of large empty boxes.
  Long legitimate fields remain fully accessible without silently shortening the stored evidence.
- Use one complete component in AskedOfYou, person cards, DecisionCard and ItemPanel. Keep the
  canonical Needs-you set/count and current session behavior; do not create duplicate cards/messages.
- Accept sends {briefId, sourceRevision, optionId, requestId} through the new choice endpoint.
  Use typed additional-input forms only where the server action requires actual input. The client
  cannot supply arbitrary routes, change captured targets/scopes or manufacture evidence.
- Label actual effects: Answer sent; Priority swapped; Reply posted; Accepted for this head;
  Controller verdict recorded; Grant recorded; Hold released, etc. “Accepted” does not mean merged
  or external work completed. Keep explicit consequences on review waivers and protected choices.
- Reuse actual person Post/Copy/handled, queue approve/deny, run rework/resume, controller-check,
  UAT, exact floor-grant and hold/release adapters supplied by the server. Keep their required notes,
  head/evidence/scope/expiry visible. Never fake a pass or use an approval word as an executor.
- Unsupported external execution stays honest. An Open/Review link is useful navigation but not
  one-click acceptance. Where the supported effect is recording/delivering the decision, say that;
  do not claim that spending/posting/external work occurred. Report any required unsupported family
  against the parent instead of treating a fallback as completed scope.
- Discuss opens ItemDiscussion inline and sends only correlated chat. It never calls choice,
  approval, acknowledgment or default actions. “Yes” in chat remains chat.
- Keep Held as the existing explicit service. Waiting metadata alone does not silently hold/hide
  the item. Released holds display refreshed state and require the server's current binding.

## States, pending work and resource ownership

- Distinguish empty, loading, failed, stale, unknown/legacy, disconnected, held and gone. Old brief
  content stays inspectable with “Needs a refreshed brief”; no fabricated missing fields or deadline.
- Disable bound choice/default controls when the server says stale/unknown/held/gone or current
  resource freshness is unavailable. Explain why and retain useful source/history navigation.
  This does not restrict separate direct operator/full-access routes.
- Persist UI-only per-item/thread draft and pending/retry context across lazy panel changes.
  A response belongs to its captured item/brief/option, never whichever item is now selected.
  Another visible row must not replace an unsent draft. Disable duplicate pending submission.
- On error, keep the brief, target, option and typed input; focus a named error summary, offer return
  to the relevant field and restore focus on close. Use the same request ID for a retry of the same
  choice; changed option/input obtains a new intent only after the prior result is resolved.
- Display durable pending/unknown receipts and server conflict reasons. Do not optimistically
  remove an item, mark it answered or assume a lost response means it is safe to execute again.
- Use the existing hub/resource cache and topic invalidation. New brief content can ride the current
  attention read model; do not create a second server-data store or fetch every hidden discussion.
  Only opened conversations/details subscribe. Countdown children must not rebuild all cards or
  refetch source/action resources every second.

## Source map

- Shared contract/resources: packages/core types from server child; apps/web/src/data.ts and api.ts
  helpers. Preserve existing authenticated bootstrap/retry and same-origin requests.
- Shared complete content/options: comms/ItemBrief.tsx and ItemBrief.css, extracted brief choice
  component as useful; existing Markdown/Expandable patterns only where compatible with open fields.
- Needs-you: flight/AskedOfYou.tsx, NeedsYouTab.tsx and scoped flight.css rules. Person cards join
  the same complete flow; existing groups/other panels remain distinct.
- Existing choices: comms/Decisions.tsx, answer.ts, shell/ItemPanel.tsx; remove the chat-as-choice
  behavior. Reuse notifications.ts/person helpers and pages/QaReadiness.tsx behavior through the
  server's typed adapter rather than copying its authorization rules into the client.
- Conversation/input: comms/ItemDiscussion.tsx and existing hold controls. Discussion remains its
  own versioned resource and state; source revision is not substituted for attentionVersion.

## Done when / meaningful tests

- [ ] Every required field, 2/4-option comparison, recommendation, no-answer behavior and delay cost
  renders initially for ordinary and person asks; imported/legacy missing data is labelled honestly.
- [ ] One-click Accept calls the exact bound recommended action on all three surfaces; ordinary
  answer, direct queue FYI and explicit approval families produce their actual typed receipts.
- [ ] An option label/ID such as “approve”, duplicate labels, forged client eligibility or chat text
  cannot select a different action or bypass the server's returned capability.
- [ ] Stale/source-changed, unknown, held, removed, disconnected and refresh-error states show
  content/reason but cannot dispatch a bound choice. Refresh alone does not make it current.
- [ ] Successful, refused, slow, duplicate, uncertain and retry responses retain correct target/input;
  changing cards/tabs during a request cannot corrupt another card or submit twice.
- [ ] Discuss is inline with per-thread history/drafts and stable correlation; no discussion test
  executes a choice, acknowledgment, grant or resolver as a side effect.
- [ ] FYIs count down from the server deadline; genuine operator reasons never do. Countdown ticks
  do not refetch/rebuild the whole inbox. Inbox count/session behavior and current FLIGHT tabs remain.
- [ ] Actual-App tests cover empty, one, normal-three and fifty asks, two/four options, long IDs/text,
  boundary fields, errors and all typed form families. Keyboard reaches the last field/action and
  complete long text; rect/hit checks prove them painted after native scroll/focus.
- [ ] Inspect real composition, useful widths, spacing, option alignment and actions at 1280/1600/1920
  plus 1600×700, light/dark and affected dock states. Preserve current shell/Agent/Crew/Knows layouts.
- [ ] Retain matched full-viewport before/after and focused detail evidence with immutable source/base,
  fixture/asset/clock provenance, actual viewport/DPR/zoom/rail/time and hashes. Use deterministic
  assets and semantic readiness; preserve any failed stages separately. Geometry alone is not design QA.
- [ ] Production-component action tests, bounded browser checks, lint/types/build, fresh independent
  review and normal CI pass. Report actual counts/filters/stages and remaining limits.

Extend ItemBrief.test.tsx, ItemPanel.test.tsx, ItemDiscussion.test.tsx, Flight/Comms decision tests,
api/data tests and focused actual-App browser fixtures. For each action, test its request and the
rendered server outcome; do not mirror component implementation with assertion-only fixtures.

## Controller check / Security

No paid/live crew or provider check is needed. Controlled fixtures/fake service transitions and
actual rendered panels establish this web outcome. No hub restart or observed-loop change.
The UI never establishes permission from text or grants authority. Existing operator and independent
controller routes retain their protections. Secret handling, immutable QA evidence/current-head
readiness and external link rules remain intact. This ticket does not add an approval gate or a new
product page. Parent #759 remains open until both children and all required acceptance flows are
delivered with current-head QA, rather than a navigation-only substitute.
