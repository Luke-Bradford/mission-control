# File evidence in Code Health

Code risk reads the selected 7-, 30- or 90-day window. Merge dates use a half-open interval, including the start and excluding the end. The cohort contains observed merged PRs retained by the hub. No ingestion watermark proves that the hub has every GitHub PR.

The existing GitHub poll captures file membership at the PR's head SHA. Its existing pagination and head-consistency checks still apply. Each membership records its SHA, declared file count and capture time. Legacy `pr_files` rows have no head provenance and cannot establish completeness. No historical head is reconstructed from a current diff.

An observed merge uses captured first-parent merge membership when available, otherwise its captured GitHub head diff. Evidence identifies the source. A background collector also captures default-branch first-parent merge diffs from committed git objects. A missing or incomplete observed diff makes touch counts and coupling unknown. Broad PRs still count as touches.

Coupling uses Map's shared definitions: at least four shared PRs and at least half the less frequently changed file's eligible PRs. Diffs with more than 25 raw paths are excluded before scope filtering. Results keep Map's 600-pair cap. A 20,000-candidate-pair limit produces a named collection gap, never an asserted zero.

File scope version 1 excludes vendor, generated, dependency, build, coverage, lock and common binary paths. Current size rows still begin with Map's largest 50 cached files, then apply that scope. The complete size collector will apply exclusions before ranking. The summary includes up to 50 size paths, 50 most-touched paths and 50 finding paths, with duplicates removed. Paths without a cached size have an unknown line count.

Incidence uses distinct reported PRs changing the file as its denominator. Every reported head in the cohort must have a complete captured file list. Multiple findings on one PR do not increase the numerator. Findings outside that PR's captured diffs remain separate counts. Evidence lists individual heads; denominator calculations deduplicate PRs.

HTTP evidence pages contain at most 50 metadata rows, without whole file lists. Issued references remain confined to one repo and source revision. The read-only `code_health` tool returns a smaller risk prefix, initially 20 files and 20 coupling pairs. It states omitted counts and reduces the prefix further if necessary. Returned references remain inspectable through the tool; the HUD API retains the full bounded summary.

The normal history sweep walks at most 100 aged memberships per pass through an indexed cursor. Snapshots older than 90 days are removed only when no retained review, PR history record or current PR head references them. No new GitHub request or worktree write is added.

## Git collection

The normal hub starts collection after two minutes, then checks every five minutes. Preview servers leave it off. One serial reader visits at most 20 configured repos with crew checkouts. It reads the local `origin/HEAD` without fetching. The analysed SHA can lag GitHub; missing merge commits then leave the PR cohort incomplete. HTTP requests read cached data and never run git.

Each source is confined to its repo, configured checkout, schema version and immutable default SHA. A cache hit rechecks the local head and attribute support without repeating the log. Late PR metadata can link existing captured commits without another log. A changed head replaces the source; failed collection makes it unavailable. Checks at least 15 minutes old are stale.

The traversal captures at most 5,000 first-parent commits and 100,000 raw paths, within the existing five-second command timeout and four-MiB output limit. It begins 91 days before the collection day. Commit dates bound traversal cost; PR merge dates select each exact 7/30/90-day cohort afterward. Every observed PR must match a captured commit before aggregate line counts are published.

Only commits with at least two parents establish a complete PR diff. A single-parent SHA might identify only the final commit of a rebase. Squash/rebase evidence stays unknown without a proven PR base. Raw paths retain changed gitlinks when applying the broad-PR exclusion. Gitlinks themselves are excluded from file touches and line counts.

Numstats use NUL-delimited rename records, preserving old and destination names. Added/deleted lines belong to the destination; a pure rename does not invent line churn. Binary counts stay unknown. Generated/vendor scope exclusions apply before aggregation. Evidence retains actual committed numstats separately from PR membership.

Attributes for all historical diffs are pinned to the analysed default head, rather than each old merge's attribute tree. System/global attribute files are disabled. Local `info/attributes` rules and named-driver binary overrides make collection unavailable. The parser uses fixed Myers/no-indent-heuristic settings and a rename limit of 2,000. Git versions without `--attr-source` also leave a collection gap. No external diff driver, textconv, filter, signature program or submodule helper runs.

Comparable size history, exclusions before size ranking, file recommendations and scoped FAO context remain follow-up work in #1346. Membership counts are never labelled as line churn. One size snapshot never establishes growth.
