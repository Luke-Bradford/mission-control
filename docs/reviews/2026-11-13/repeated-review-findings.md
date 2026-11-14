# Repeated review findings, 6–13 November 2026 (#1644)

Follows #1618. Measured from the repository's own history, because the hub's review reports and
heads sit in its database, which a developer seat cannot read.

## What was measured

Every PR merged on `main` since 6 November: 157 merges, 630 non-merge commits, 124 PRs with more
than one commit. A commit after a PR's first one is the best stand-in for a rework round that git
holds. Each commit was put in one class by its subject line (`git log` over each merge's
`first-parent..second-parent` range). Counts are commits and PRs, not review findings.

## Table

| Class | Commits | PRs | Heaviest PRs (commits of total), with ticket | Deterministic local check | Coverage today |
|---|---|---|---|---|---|
| Format or import order after a change | 46 | 32 | 1655 (7 of 20; ticket 1596), 1520 (4 of 8; 1503), 1486 (3 of 12; 1405) | `pnpm -s lint` (biome) | Covered by `lint`, which runs before a report. Style commits follow rework: the check was not rerun after the last edit. The push gate's exact-head rule (#1626, #1677) closes that. |
| Reader comment, route reader or reader inventory | 12 | 8 | 1759 (5 of 12; 1667), 1415 (1 of 12; 1389) | `apps/server/test/routes.test.ts` | Covered, but runs in `test:related` only when routes change. |
| Stale link, path or line reference | 34 | 24 | 1759 (1667), 1601 (1581), 1690 (1686) | Partly: prototype link check (#1690); web token check | Partly. Doc path and line references still need a reader. |
| Stray files committed (sed `-E` backups, screenshots, proof runs) | 2 | 2 | 1752 (1 of 3; ticket 1749), 1415 (1 of 12; ticket 1389) | **New:** `apps/server/scripts/check-stray-files.ts`, with `apps/server/test/repo-hygiene.test.ts` | Script and test added here. Not yet in a pre-report check: see gaps. |
| Review fix, behaviour or contract (other) | 73 | 37 | 1655 (8 of 20; 1596), 1407 (6 of 14; 1397), 1490 (6 of 6; 1477), 1484 (6 of 8; 1419) | None. Needs judgement | Stays independent review work. |

The four rows above the last are mechanical. They hold about 94 of the 630 commits. The last row
is the review's real work and is not touched.

## Reproduction of real findings

- PR 1752 (ticket 1749), commit `6b116559`: six `*.test.ts-E` files, 23,221 lines, left by `sed -i -E`
  in a move. The test's first case uses those names and fails on them.
- PR 1415 (ticket 1389), commit `6193c455`: 46 files of briefs proof logs (`*.log.gz`, manifest JSON) removed
  from the branch. The test's third case uses those paths and fails on the earlier regex. Its subject also
  names a reader, so it was first counted as a reader commit; it is now counted here only.
  The class came up in two PRs, so the check answers a repeated failure.
- PR 1761 (a `chore/` branch, no ticket) is the 11 November policy clean-up that removed committed
  screenshots and proof runs. It is not a review finding and is not counted in the table. The proof-file
  rule backs up `.gitignore` against `git add -f`; the second test case uses the paths that PR removed.
- The last case runs the check over every tracked file; it passes today.
- Failure output is the path plus the reason and the fix, one line per file. The script exits 1 on any.

## False positives and gaps

- The classes come from commit subjects, so a commit titled "format" that also changed behaviour
  counts as format. The 46 is an upper bound for that class.
- The check flags `-E`, `.orig`, `.bak`, `.rej` and `~` suffixes and proof files under
  `docs/evidence` and `docs/reviews` (every file except `.md`, as `.gitignore` does). It
  would flag a real file whose name ends in `-E`; none is tracked.
- **Not yet before a report.** `test:related` picks tests by import graph, so the test alone never runs
  for a stray file. The script runs over `git ls-files` and needs one change outside the server area:
  append `&& node --experimental-strip-types apps/server/scripts/check-stray-files.ts` to the root
  `lint` script in `package.json`. FLIGHT will make this change on its own after this PR merges; its number is not yet known.

## Missing evidence

- Review reports and heads per round, from the hub database: not readable from a developer seat.
  Without them, findings cannot be counted per round or linked to a report.
- Tickets: every PR listed above has one in its branch name except 1761, a `chore/` branch.
- The finding text itself, so classes above are by commit subject, not by finding.
- The 8 November baseline (229 review runs, 154 merges) was not recomputed.
- Which rework commits were answers to review and which were the author's own follow-up.

## Model configuration

- `config.example.yaml` gives `retro-1` the model `opus` and no `light_model`.
  `docs/reviews/2026-11-08/token-efficiency.md` records that neither review seat sets `light_model`.
- The live `config.yaml` is outside a developer seat's reach, so the running value is unconfirmed.
- The code uses `light_model` only for Size XS or S, or chore, test and docs tickets
  (`reviewDepth`, `apps/server/src/runtime/supervisor.ts`). Features, fixes and Size M or larger
  keep the full model. This change alters none of that.

## Seven-day measurement

Not done by this change. It starts at this change's merge and deployment and is tracked under #1431's
Controller check. Passing tests here do not show the outcome. Measure review rounds per merge by the
hub's reports, and format and stray-file commits per PR, against this table.
