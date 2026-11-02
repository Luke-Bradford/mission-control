# File evidence in Code Health

Code risk reads the selected 7-, 30- or 90-day window. Merge dates use a half-open interval, including the start and excluding the end. The cohort contains observed merged PRs retained by the hub. No ingestion watermark proves that the hub has every GitHub PR.

The existing GitHub poll captures file membership at the PR's head SHA. Its existing pagination and head-consistency checks still apply. Each membership records its SHA, declared file count and capture time. Legacy `pr_files` rows have no head provenance and cannot establish completeness. No historical head is reconstructed from a current diff.

An observed merge uses captured first-parent merge membership when available, otherwise its captured GitHub head diff. Evidence identifies the source. This change adds head capture; the read-only git collector follows separately. A missing or incomplete observed diff makes touch counts and coupling unknown. Broad PRs still count as touches.

Coupling uses Map's shared definitions: at least four shared PRs and at least half the less frequently changed file's eligible PRs. Diffs with more than 25 raw paths are excluded before scope filtering. Results keep Map's 600-pair cap. A 20,000-candidate-pair limit produces a named collection gap, never an asserted zero.

File scope version 1 excludes vendor, generated, dependency, build, coverage, lock and common binary paths. Current size rows still begin with Map's largest 50 cached files, then apply that scope. The complete size collector will apply exclusions before ranking. The summary includes up to 50 size paths, 50 most-touched paths and 50 finding paths, with duplicates removed. Paths without a cached size have an unknown line count.

Incidence uses distinct reported PRs changing the file as its denominator. Every reported head in the cohort must have a complete captured file list. Multiple findings on one PR do not increase the numerator. Findings outside that PR's captured diffs remain separate counts. Evidence lists individual heads; denominator calculations deduplicate PRs.

HTTP evidence pages contain at most 50 metadata rows, without whole file lists. Issued references remain confined to one repo and source revision. The read-only `code_health` tool returns a smaller risk prefix, initially 20 files and 20 coupling pairs. It states omitted counts and reduces the prefix further if necessary. Returned references remain inspectable through the tool; the HUD API retains the full bounded summary.

The normal history sweep walks at most 100 aged memberships per pass through an indexed cursor. Snapshots older than 90 days are removed only when no retained review, PR history record or current PR head references them. No new GitHub request or worktree write is added.

Per-file git additions/deletions, comparable size history and scoped FAO context remain follow-up work in #1346. Membership counts are never labelled as line churn. One size snapshot never establishes growth.
