# Standing instructions web: implementation and QA record

Issue #1378, child of #993. Dependency #1377 is the reviewed server contract carried by base
`f205cab3e5b2bb8ab4c26f15ad6bf4ea7215a42f`. This record does not claim that dependency merged.
No new operator approval gate, policy tier or actual-provider proof is part of the web outcome.

## Scope and ownership

The implementation replaces the two existing Knows placeholders, adds a named active-order status
control, and uses one instruction reader/editor on Agent and FLIGHT. Agent's delivered layout is
preserved: a lazy instruction disclosure joins its current-context column. The existing Seats panel
uses the HUD segmented control for Seats versus Instructions; its default table stays intact.
Overview and shared shell/dock behavior remain separate work owned by the Overview author.

Wire types derive from core StandingInstruction and list/mutation types. New core DTOs name the
existing read responses; they change no server behavior. Global orders have no repo selector.
Operator identity, authorship and timestamps are never form fields. Existing authenticated API
helpers retain the 401/bootstrap/retry protocol. Replacements and revocations retain server history.

Global status reads request limit=1, the stable route's smallest included history page, while still
receiving the complete active set. That includes at most one revoked row from the shared response;
there is no new active-only API. A full 50-row history resource mounts only when history opens.
Seat indexes load on the owning tab/view; detailed seat readers mount only for opened targets.
All server data stays in the existing hub cache. A separate UI store retains target-specific drafts,
errors, selected open targets and pending state across lazy unmounts. It is not another server cache.

Focus changes retain the existing Queue editor and selector grammar. Clear saves an operator null
instruction. Revoke is separate and previews the resulting source, including a revealed FLIGHT focus.
Re-plan links resolve the exact retained global order through its detail endpoint, independent of
history pagination; revoked orders remain explicitly revoked.

## Author stages retained

- Initial core/web types reported three integration diagnostics: nullable saved-source access, a
  numeric resource function missing from the catalog signature, and the action-inventory call shape.
  Named scroll-region lint comments also needed correction. Both logs are retained.
- First component run exposed a real refetch loop: generated resource functions allocated new topic
  arrays each render, resubscribing and fetching through useResource. The worker exceeded 80 seconds
  at 106.9% CPU without completing a test. Its log and process receipt were saved; only recorded
  task-owned test PIDs were ended, and their exit was verified. Stable module-level topic constants
  fix the cause. The fixture now checks typing does not refetch the same reader.
- Next component run: 10 passed/2 failed (2.60s). Two fixture waits/lookups were premature: textarea
  text matched before refreshed active rows, and the focus lookup read the nested label instead of
  its full source paragraph. The actual DOM showed the correct FLIGHT source. Assertions now wait
  for real replacement/revoke controls and inspect the complete source line.
- Next component run: 11 passed/1 failed (1.64s). The mock accepted an unauthenticated write, so the
  existing helper never bootstrapped. The fixture now refuses it with the actual 401 error before
  mutation, verifies one retry and exactly three accepted authenticated writes. No auth helper changed.
- New action fixtures then passed 12/12 (1.65s). Selected existing Flight/Agent/data/API regressions
  passed 55, with 291 filtered (1.93s); flightConversation was entirely filtered in that command.
- Adding actual Agent Queue Clear -> revoke -> FLIGHT-source coverage passed 13/13, then the Crew
  mode regression brought the component file to 14/14 (1.86s). Capture-only type/lint diagnostics
  (duplicate width metric and comment placement) were fixed; no capture timeout was increased.
- Actual App orders at 1600x700: all five datasets in both themes passed (one selected test,
  11 filtered, 8.07s). Native Tab reached painted Save/Cancel; full text retained 4,000 UTF-16 units
  and End reached the last painted glyph. Initial inspection corrected an over-wide Add action and
  applied the 32px form-control minimum, without a page redesign.
- Next three-view App stage: orders and Agent passed (20 scenes); Crew failed (1 failed/2 passed,
  9 filtered, 44.93s). Its appended control was covered by the Seats table's Free pill during a real
  click. It moved to the existing segmented panel header, with only the selected body mounted.
- Focused Crew stage then found a genuine short-pane clipping problem: the active reader was 320px
  tall inside an approximately 212px body. End reached remaining=0 but the last row was hidden
  behind the panel boundary. The unchanged paint assertion rejected it. The Crew reader now has a
  viewport-sensitive cap; the original red frame/metrics remain retained. The next focused Crew
  run passed ten actual-App scenes (five datasets, both themes; one test passed/11 filtered,
  10.48s). Inspected last-row metrics show remaining=0 with the last operator-clear row painted;
  the boundary reader retained all 4,000 UTF-16 units and its last glyph was painted at remaining=2.
- The following component/API stage passed 45/45 (14 instruction cases, 31 API cases; 1.97s),
  with core/web types exit 0. Formatting exited 0 with two warnings in QA-only code; those were
  then corrected by recording the declared source/harness provenance and using optional chaining.

- Source follow-through found another visible Replace action could discard an open replacement draft.
  It now respects the same-target edit boundary, with a two-row retained-draft regression. The
  checkpoint pack passed all 361 affected tests across six files (including 15 instruction cases),
  4.64s; core/web types and changed-file formatting passed without diagnostics.

## Checks still required before completion

This is an implementation-progress record, not QA approval. Remaining work: capture and inspect the final changed panels across 1280/1600/1920 and 1600x700, light/dark,
empty/one/50/long/4,000-unit data; retain matched before/after actual-App evidence; complete affected
regressions and integrated lint/types/build; then a fresh whole-branch review and normal CI.
No full local suite is authorized. Heavy jobs run one at a time, at most three unit workers or one
browser worker, with immediate lane release after commands. All API fixtures are fictional and
intercepted on the browser runner's made-up origin. No live/provider/crew/observed-loop writes occur.
