# Repeated review findings, 6–13 November 2026 (#1644)

Follows #1618. Measured from the repository's own history, because the hub's review reports and
heads sit in its database, which a developer seat cannot read.

## What was measured

Every PR merged on `main` since 6 November: 157 merges, 630 non-merge commits, 124 PRs with more
than one commit. A commit after a PR's first one is the best stand-in for a rework round that git
holds. Each commit was put in one class by its subject line (`git log` over each merge's
`first-parent..second-parent` range). Counts are commits and PRs, not review findings.

## Table

| Class | Commits | PRs | Heaviest PRs (commits of total) | Deterministic local check | Coverage today |
|---|---|---|---|---|---|
| Format or import order after a change | 46 | 32 | 1655 (7 of 20), 1520 (4 of 8), 1486 (3 of 12) | `pnpm -s lint` (biome) | Covered by `lint`, which runs before a report. Style commits follow rework: the check was not rerun after the last edit. The push gate's exact-head rule (#1626, #1677) closes that. |
| Reader comment, route reader or reader inventory | 13 | 8 | 1759 (5 of 12), 1415 (2 of 12) | `apps/server/test/routes.test.ts` | Covered, but runs in `test:related` only when routes change. |
| Stale link, path or line reference | 34 | 24 | 1759, 1601, 1690 | Partly: prototype link check (#1690); web token check | Partly. Doc path and line references still need a reader. |
| Stray files committed (sed `-E` backups, screenshots, proof runs) | 3 | 2 | 1761 (2 of 2), 1752 (1 of 3) | **New:** `apps/server/test/repo-hygiene.test.ts` | Added here. It names each file and the fix. |
| Review fix, behaviour or contract (other) | 73 | 37 | 1655 (8 of 20), 1407 (6 of 14), 1490 (6 of 6), 1484 (6 of 8) | None. Needs judgement | Stays independent review work. |

The four rows above the last are mechanical. They hold about 96 of the 630 commits. The last row
is the review's real work and is not touched.

## Reproduction of real findings

- PR 1752, commit `6b116559`: six `*.test.ts-E` files, 23,221 lines, left by `sed -i -E` in a move.
  The new test's first case uses those names and fails on them.
- PR 1761, commits `852e28ad` and `d7af2ec2`: screenshots, proof scripts and artifact JSON under
  `docs/evidence` and `docs/reviews`. The second case uses those paths.
- The third case runs the check over every tracked file; it passes today.
- Failure output is the path plus the reason and the fix, one line per file.

## False positives and gaps

- The classes come from commit subjects, so a commit titled "format" that also changed behaviour
  counts as format. The 46 is an upper bound for that class.
- The new check flags `-E`, `.orig`, `.bak`, `.rej` and `~` suffixes and proof files under
  `docs/evidence` and `docs/reviews` (any `.png`, `.jpg`, `.json`, `.ts`; only `.md` is kept). It
  would flag a real file whose name ends in `-E`; none is tracked.
- It runs in CI and in `test:related` only when the file it imports changes (it imports nothing
  from `src`). A pre-report run needs it in the repo's `lint` script (`package.json`) or as a
  `checks` entry in `CLAUDE.md`. Both are outside the server area; FLIGHT owns that change.

## Missing evidence

- Review reports and heads per round, from the hub database: not readable from a developer seat.
  Without them, findings cannot be counted per round or linked to a report.
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
