# Standing instructions web: implementation and QA record

Current correction: source `76a00706`, documented in [watch-correction.md](watch-correction.md).
The full matrix below remains historical source261/docs959 evidence. Its whole-branch review
completed with one Minor and no Important/Critical finding; the narrow correction awaits same-pass verification.

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

## Final author validation

Product source `261171462c78640bc339e46d9645a4a90490b678` passed 361 affected tests, core/web
then full workspace types, lint and production build. Lint retains 76 warnings and seven infos,
matching the dependency's integrated-lint counts; the 18 changed source/test files passed their
separate formatter/lint check without diagnostics. No full local suite or test:related expansion
ran: the controller explicitly authorized bounded affected checks and normal CI instead.

The final matched actual-App run covers 120 context scenes per side: orders, Crew and Agent at
1280x1000, 1600x1000, 1920x1080 and 1600x700; light/dark; empty, one, 50, long and boundary-sized
instructions. The baseline is exact f205 production plus identical untracked capture instrumentation.
All 24 selected browser cases passed (12 per side), with nine filtered per bounded viewport command.
There are 576 PNGs and 336 JSON receipts. Their SHA-256 index is [artifacts.json](artifacts.json);
exact commands and bounded pass/filter counts are in [checks.md](checks.md).

Author inspection of real context/interaction frames found readable ID/target/date/source groups,
distinct Active/Revoked words, useful text wrapping and standard HUD actions. At 1280, Knows keeps
two useful columns; at 1920 the rows retain their own actions and metadata rather than stretching
isolated numbers. Memory and working context remain separate. Global readers cap at 320px; Crew
uses its existing independently scrolling Seats panel and caps its active reader to the viewport.
Opening or focusing a long Crew target can scroll that containing pane; no claim is made that all
50 entries fit in the first screen. The default Seats table and Agent's delivered layout are preserved.
Agent instructions are a closed-by-default disclosure in the existing context hierarchy; opening
large content can scroll the existing Agent page. Full-content readers have a visible focus outline.

Final native keyboard receipts show all 24 last-row checks painted at remaining=0, all 48 long or
4,000-UTF-16-unit readers painted at remaining<=2, and all 24 editor Save controls painted. Text is
not silently capped; the active set is complete and history alone paginates. Repeated errors, stale
reads, disconnection, target/draft retention, pending dedupe, authenticated refusal/retry, stable
revoked links beyond page one and Clear versus revoke have production-component action coverage.
The browser captures are fictional intercepted fixtures, not actual-provider or live-crew proof.

Fresh whole-branch review, controller QA registration and exact-head normal CI remain outstanding.
The dependency stays stacked until the controller composes/merges it. No push, PR publication,
live/provider/crew/observed-loop writes, shared shell redesign or Overview change occurred here.
