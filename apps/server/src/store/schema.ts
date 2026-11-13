export const SCHEMA = `
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, repo_id TEXT NOT NULL, seq INTEGER NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL, session_id TEXT,
  model TEXT, branch TEXT, ticket TEXT, cost_usd REAL, tokens TEXT, transcript_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, started_at);
-- Kept apart from runs so run queries stay small; written on its own change check.
CREATE TABLE IF NOT EXISTS run_digests (run_id TEXT PRIMARY KEY, digest TEXT NOT NULL);
-- Map snapshot parts that never change for their key (a commit's tree and imports, a merge's files).
CREATE TABLE IF NOT EXISTS map_cache (
  kind TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (kind, scope, key)
);
-- HUD state changes that matter (#26 B14): into or out of a notable state.
CREATE TABLE IF NOT EXISTS agent_events (
  agent_id TEXT NOT NULL, at INTEGER NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL,
  text TEXT NOT NULL, PRIMARY KEY (agent_id, at)
);
CREATE TABLE IF NOT EXISTS usage_samples (
  account_id TEXT NOT NULL, window TEXT NOT NULL, at INTEGER NOT NULL, pct REAL NOT NULL,
  reset_at INTEGER NOT NULL, source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_lookup ON usage_samples(account_id, window, at);
CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, issue_number INTEGER NOT NULL, title TEXT NOT NULL,
  kind TEXT NOT NULL, opened_at INTEGER NOT NULL, url TEXT NOT NULL, question TEXT,
  source TEXT NOT NULL DEFAULT 'label'
);
CREATE TABLE IF NOT EXISTS board_items (
  repo_id TEXT NOT NULL, issue_number INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  state TEXT NOT NULL, labels TEXT NOT NULL, priority TEXT, updated_at INTEGER NOT NULL,
  url TEXT NOT NULL, stage TEXT, owner TEXT, parent INTEGER, sub_done INTEGER, sub_total INTEGER,
  blocked_by TEXT NOT NULL DEFAULT '[]', milestone TEXT, PRIMARY KEY (repo_id, issue_number)
);
CREATE TABLE IF NOT EXISTS pull_requests (
  repo_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
  branch TEXT NOT NULL, ticket TEXT, state TEXT NOT NULL, is_draft INTEGER NOT NULL,
  review TEXT, ci TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, merged_at INTEGER,
  PRIMARY KEY (repo_id, number)
);
-- A merged PR outlives the bounded live PR cache used by the board.
CREATE TABLE IF NOT EXISTS pr_history (
  repo_id TEXT NOT NULL, number INTEGER NOT NULL, merged_at INTEGER NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY (repo_id, number)
);
CREATE INDEX IF NOT EXISTS pr_history_merged ON pr_history(repo_id, merged_at);
-- A PR's diff files as GitHub read them (first PR_FILES_MAX); the tests-per-PR count and the
-- file route of escaped defects read them.
CREATE TABLE IF NOT EXISTS pr_files (
  repo_id TEXT NOT NULL, pr_number INTEGER NOT NULL, path TEXT NOT NULL, change_type TEXT NOT NULL,
  PRIMARY KEY (repo_id, pr_number, path)
);
-- A bug filed after a PR merged that names it, a commit of it or a file only it changed. Kept
-- after the card leaves the board; seat and model are the PR branch's author run.
CREATE TABLE IF NOT EXISTS escaped_defects (
  repo_id TEXT NOT NULL, issue_number INTEGER NOT NULL, pr_number INTEGER NOT NULL,
  via TEXT NOT NULL, filed_at INTEGER NOT NULL, merged_at INTEGER NOT NULL, seat TEXT, model TEXT,
  PRIMARY KEY (repo_id, issue_number, pr_number)
);
CREATE INDEX IF NOT EXISTS escaped_defects_merged ON escaped_defects(merged_at);
CREATE TABLE IF NOT EXISTS retrospectives (
  repo_id TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, report TEXT NOT NULL,
  PRIMARY KEY (repo_id, day)
);
CREATE TABLE IF NOT EXISTS prompt_versions (
  hash TEXT PRIMARY KEY, path TEXT NOT NULL, first_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prompt_sections (
  run_id TEXT NOT NULL, wake INTEGER NOT NULL, section TEXT NOT NULL,
  bytes INTEGER NOT NULL, tokens INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (run_id, wake, section)
);
CREATE INDEX IF NOT EXISTS prompt_sections_at ON prompt_sections(at);
CREATE TABLE IF NOT EXISTS run_token_audit (
  run_id TEXT PRIMARY KEY, at INTEGER NOT NULL, calls INTEGER NOT NULL, peak_context INTEGER NOT NULL,
  median_context INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
  output INTEGER NOT NULL, rewrites INTEGER NOT NULL, rewrite_tokens INTEGER NOT NULL,
  read_after_report INTEGER, by_source TEXT NOT NULL, by_command TEXT NOT NULL,
  timestamps_checked INTEGER NOT NULL DEFAULT 0
);
-- Each finished mc tool call: when, which, and the characters sent and returned (Audit's tool rows).
CREATE TABLE IF NOT EXISTS mcp_tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, run_id TEXT NOT NULL,
  tool TEXT NOT NULL, written INTEGER NOT NULL, returned INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_tool_calls_at ON mcp_tool_calls(at);
CREATE TABLE IF NOT EXISTS run_token_calls (
  run_id TEXT NOT NULL, idx INTEGER NOT NULL, context INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL, output INTEGER NOT NULL, added TEXT NOT NULL, at INTEGER,
  PRIMARY KEY (run_id, idx)
);
CREATE TABLE IF NOT EXISTS controller_messages (
  message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL, input INTEGER NOT NULL,
  cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS controller_messages_at ON controller_messages(at);
CREATE TABLE IF NOT EXISTS controller_files (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS flow_issues (
  repo_id TEXT NOT NULL, number INTEGER NOT NULL, size TEXT, start_at INTEGER,
  done_at INTEGER, PRIMARY KEY (repo_id, number)
);
CREATE TABLE IF NOT EXISTS flow_prs (
  repo_id TEXT NOT NULL, number INTEGER NOT NULL, merged_at INTEGER NOT NULL, first_push_ci TEXT,
  PRIMARY KEY (repo_id, number)
);
CREATE TABLE IF NOT EXISTS file_offsets (path TEXT PRIMARY KEY, offset INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS collector_status (
  collector TEXT PRIMARY KEY, ok INTEGER NOT NULL, error TEXT, at INTEGER NOT NULL,
  last_ok_at INTEGER, failing_since INTEGER
);
CREATE TABLE IF NOT EXISTS machine_samples (at INTEGER PRIMARY KEY, sample TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Acknowledged attention items. absent_since: when the key was first missing from the current
-- items (null while present); the ack is dropped once it has been absent for ACK_ABSENT_MS.
CREATE TABLE IF NOT EXISTS acks (key TEXT PRIMARY KEY, at INTEGER NOT NULL, absent_since INTEGER);
CREATE TABLE IF NOT EXISTS decision_defaults (
  key TEXT NOT NULL, brief_at INTEGER NOT NULL, option_id TEXT, label TEXT NOT NULL,
  due_at INTEGER NOT NULL, applied_at INTEGER NOT NULL, target TEXT, answer TEXT,
  delivered_at INTEGER, PRIMARY KEY (key, brief_at)
);
-- The operator's choice on a question: one row per brief, kept with the ticket's history.
CREATE TABLE IF NOT EXISTS question_choices (
  key TEXT NOT NULL, brief_at INTEGER NOT NULL, option_id TEXT NOT NULL, label TEXT NOT NULL,
  answer TEXT NOT NULL, question TEXT NOT NULL, ticket TEXT, target TEXT NOT NULL,
  target_kind TEXT NOT NULL, message_id INTEGER, chosen_at INTEGER NOT NULL, chosen_by TEXT,
  PRIMARY KEY (key, brief_at)
);
CREATE INDEX IF NOT EXISTS question_choices_ticket ON question_choices(ticket);
CREATE INDEX IF NOT EXISTS question_choices_message ON question_choices(message_id);
-- Status moves of a run's card (pending, then done or failed); the Activity page's board rows.
CREATE TABLE IF NOT EXISTS board_moves (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, repo_id TEXT NOT NULL, issue INTEGER NOT NULL,
  board_column TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS board_moves_at ON board_moves(at);
CREATE INDEX IF NOT EXISTS board_moves_card ON board_moves(repo_id, issue, state, at);
-- What a run's seat reported (append-only); the loop's reconciler reads the latest.
CREATE TABLE IF NOT EXISTS run_evidence (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, note TEXT NOT NULL, at INTEGER NOT NULL,
  tests TEXT NOT NULL DEFAULT '[]', tests_added TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS run_evidence_run ON run_evidence(run_id);
-- The ticket's Done-when lines as they stood when a run started; a report must answer each one.
CREATE TABLE IF NOT EXISTS run_done_when (
  run_id TEXT NOT NULL, pos INTEGER NOT NULL, line TEXT NOT NULL, PRIMARY KEY (run_id, pos)
);
-- One review of a run's pushed sha (7b-1); attempt counts the tries of one sha within a loop epoch.
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY, author_run_id TEXT NOT NULL, repo_id TEXT NOT NULL, seat_id TEXT NOT NULL,
  pr_number INTEGER NOT NULL, sha TEXT NOT NULL, epoch INTEGER NOT NULL, attempt INTEGER NOT NULL,
  round INTEGER NOT NULL, state TEXT NOT NULL, run_id TEXT, verdict TEXT, summary TEXT,
  blocking INTEGER NOT NULL DEFAULT 0, minor INTEGER NOT NULL DEFAULT 0, failure TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
  UNIQUE (author_run_id, sha, epoch, attempt)
);
CREATE INDEX IF NOT EXISTS reviews_state ON reviews(state, created_at);
-- A FLIGHT-directed queued-review move overrides the engine's ordinary reviewer selection.
CREATE TABLE IF NOT EXISTS review_moves (
  review_id INTEGER PRIMARY KEY, seat_id TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS review_findings (
  id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL, author_run_id TEXT NOT NULL, pos INTEGER NOT NULL,
  severity TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, summary TEXT NOT NULL,
  scenario TEXT NOT NULL, fix TEXT NOT NULL, category TEXT, state TEXT NOT NULL, UNIQUE (review_id, pos)
);
CREATE TABLE IF NOT EXISTS review_checks (
  review_id INTEGER NOT NULL, check_id TEXT NOT NULL, result TEXT NOT NULL, note TEXT,
  PRIMARY KEY (review_id, check_id)
);
-- Immutable QA snapshots are independent of the native review/run retention sweep.
CREATE TABLE IF NOT EXISTS qa_reports (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL, registered_at INTEGER NOT NULL, native_review_id INTEGER UNIQUE,
  report TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS qa_reports_subject ON qa_reports(repo_id, pr_number, head_sha, registered_at DESC);
CREATE INDEX IF NOT EXISTS qa_reports_history ON qa_reports(repo_id, registered_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS reviews_history ON reviews(repo_id, COALESCE(ended_at, created_at) DESC, id DESC) WHERE state IN ('reported', 'failed', 'superseded');
CREATE TABLE IF NOT EXISTS review_shots (
  id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL, shot_id TEXT NOT NULL, label TEXT NOT NULL,
  width INTEGER NOT NULL, theme TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS review_shots_review ON review_shots (review_id);
CREATE TABLE IF NOT EXISTS review_tests (
  id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL, command TEXT NOT NULL, file TEXT,
  passed INTEGER NOT NULL, failed INTEGER NOT NULL, skipped INTEGER NOT NULL, duration INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS review_resolutions (
  review_id INTEGER NOT NULL, prior_review_id INTEGER NOT NULL, finding_pos INTEGER NOT NULL,
  outcome TEXT NOT NULL, PRIMARY KEY (review_id, prior_review_id, finding_pos)
);
-- One row per check run of a PR head, kept as the hub polled it: updated in place as it concludes.
CREATE TABLE IF NOT EXISTS ci_runs (
  repo_id TEXT NOT NULL, run_key TEXT NOT NULL, sha TEXT NOT NULL, name TEXT NOT NULL,
  attempt INTEGER NOT NULL, pr_number INTEGER NOT NULL, workflow TEXT, state TEXT NOT NULL,
  conclusion TEXT NOT NULL, url TEXT, first_seen_at INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, run_key)
);
CREATE INDEX IF NOT EXISTS ci_runs_at ON ci_runs(at);
-- A repo's milestones as GitHub last answered, replaced whole on each read.
CREATE TABLE IF NOT EXISTS milestones (
  repo_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
  due_on INTEGER, open INTEGER NOT NULL, closed INTEGER NOT NULL, PRIMARY KEY (repo_id, number)
);
-- Lines sent to a seat, one row per key: a claimed key is never sent twice.
CREATE TABLE IF NOT EXISTS seat_lines (
  key TEXT PRIMARY KEY, run_id TEXT NOT NULL, seat_id TEXT NOT NULL, origin TEXT NOT NULL,
  text TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS seat_lines_run ON seat_lines(run_id);
-- The Activity page's loop rows; the key makes a re-emitted event land once.
CREATE TABLE IF NOT EXISTS loop_events (
  key TEXT PRIMARY KEY, run_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS loop_events_at ON loop_events(at);
CREATE TABLE IF NOT EXISTS run_handoffs (
  run_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, ticket TEXT NOT NULL, at INTEGER NOT NULL,
  record TEXT NOT NULL, accepted_by TEXT, accepted_run_id TEXT, claim_token TEXT
);
CREATE INDEX IF NOT EXISTS run_handoffs_ticket ON run_handoffs(repo_id, ticket, at DESC);
CREATE INDEX IF NOT EXISTS run_handoffs_received ON run_handoffs(accepted_run_id);
-- Hand-offs between agents (Activity › Messages): who told whom what, about which ticket.
CREATE TABLE IF NOT EXISTS comms (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, from_id TEXT NOT NULL,
  to_id TEXT NOT NULL, ticket TEXT, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comms_at ON comms(at);
-- Each exact repeat of a stored message that was turned away, for the count in Audit.
CREATE TABLE IF NOT EXISTS comms_repeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, from_id TEXT NOT NULL,
  to_id TEXT NOT NULL, message_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comms_from_id ON comms(from_id, id);
CREATE INDEX IF NOT EXISTS comms_to_id ON comms(to_id, id);
CREATE TABLE IF NOT EXISTS comms_reads (
  thread_id TEXT NOT NULL, source_id TEXT NOT NULL, offset INTEGER NOT NULL, block INTEGER NOT NULL,
  PRIMARY KEY (thread_id, source_id)
);
-- The Activity page's hub rows (an automatic update); the primary key keeps a line landing once.
CREATE TABLE IF NOT EXISTS hub_events (
  at INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (at, text)
);
-- A seat's next issues; taken_at is set while a seat holds the head and has not started its run.
CREATE TABLE IF NOT EXISTS queues (
  seat_id TEXT NOT NULL, pos INTEGER NOT NULL, repo_id TEXT NOT NULL, issue INTEGER NOT NULL,
  taken_at INTEGER, PRIMARY KEY (seat_id, pos)
);
-- Needs-you notes the engine raises; cleared_at is set once the cause is gone, dismissed_at when the operator dismissed it (reset when it is raised again).
-- Things the hub did or needs decided, with the risk tier fixed by the item's kind when recorded.
CREATE TABLE IF NOT EXISTS audit_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, subject TEXT NOT NULL,
  tier TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL,
  UNIQUE (kind, subject)
);
CREATE INDEX IF NOT EXISTS audit_items_at ON audit_items(at);
CREATE TABLE IF NOT EXISTS attention_notes (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, run_id TEXT, seat_id TEXT, repo_id TEXT,
  text TEXT NOT NULL, at INTEGER NOT NULL, cleared_at INTEGER, dismissed_at INTEGER
);
-- Preserve every note episode, including the history available on upgrade.
CREATE TABLE IF NOT EXISTS attention_episodes (
  key TEXT NOT NULL, kind TEXT NOT NULL, seat_id TEXT, at INTEGER NOT NULL,
  cleared_at INTEGER
);
CREATE TRIGGER IF NOT EXISTS attention_episode_open AFTER INSERT ON attention_notes BEGIN
  INSERT INTO attention_episodes VALUES (NEW.key, NEW.kind, NEW.seat_id, NEW.at, NEW.cleared_at);
END;
CREATE TRIGGER IF NOT EXISTS attention_episode_reopen AFTER UPDATE ON attention_notes
WHEN OLD.cleared_at IS NOT NULL AND NEW.cleared_at IS NULL BEGIN
  INSERT INTO attention_episodes VALUES (NEW.key, NEW.kind, NEW.seat_id, NEW.at, NULL);
END;
CREATE TRIGGER IF NOT EXISTS attention_episode_close AFTER UPDATE ON attention_notes
WHEN OLD.cleared_at IS NULL AND NEW.cleared_at IS NOT NULL BEGIN
  UPDATE attention_episodes SET cleared_at = NEW.cleared_at WHERE key = OLD.key AND cleared_at IS NULL;
END;
-- One row per crew seat (phase 2a); run_id is null when no run is active.
CREATE TABLE IF NOT EXISTS seat_sessions (
  seat_id TEXT PRIMARY KEY, run_id TEXT, cli_session_id TEXT, state TEXT NOT NULL, reason TEXT,
  worktree TEXT, updated_at INTEGER NOT NULL
);
-- Tool calls the guard refused (phase 2b). text: the rule's text plus program and subcommand.
CREATE TABLE IF NOT EXISTS guard_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, run_id TEXT, rule TEXT NOT NULL,
  text TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS guard_hits_at ON guard_hits(at);
-- Each run's latest whole read of a large file, and what its refused re-reads saved (guard.ts rereadVerdict).
CREATE TABLE IF NOT EXISTS run_reads (
  run_id TEXT NOT NULL, agent_id TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
  compactions INTEGER NOT NULL, tool_use_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (run_id, agent_id, path)
);
CREATE TABLE IF NOT EXISTS run_rereads (
  run_id TEXT PRIMARY KEY, count INTEGER NOT NULL, tokens_saved INTEGER NOT NULL
);
-- Commits the mc commit tool made (phase 2b): the only commits a push may send.
CREATE TABLE IF NOT EXISTS run_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, repo_id TEXT NOT NULL,
  branch TEXT NOT NULL, sha TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (run_id, sha)
);
CREATE TABLE IF NOT EXISTS commit_lines (
  sha TEXT PRIMARY KEY, additions INTEGER, deletions INTEGER
);
CREATE INDEX IF NOT EXISTS run_commits_first ON run_commits(repo_id, sha, at, id);
CREATE INDEX IF NOT EXISTS run_commits_branch ON run_commits(repo_id, branch);
CREATE INDEX IF NOT EXISTS run_commits_at ON run_commits(at);
-- Append-only observations for a run and its linked review runs.
CREATE TABLE IF NOT EXISTS run_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, kind TEXT NOT NULL,
  at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_attempts_run ON run_attempts(run_id, id);
-- The sha a run last pushed to its branch, or found origin already at (phase 2b): draft_pr needs
-- it to be the branch's tip.
CREATE TABLE IF NOT EXISTS run_pushes (run_id TEXT PRIMARY KEY, sha TEXT NOT NULL, at INTEGER NOT NULL);
-- Paths a refused commit had outside the seat's area (Needs you). key: strayKey(session, path).
CREATE TABLE IF NOT EXISTS strays (
  key TEXT PRIMARY KEY, session_id TEXT NOT NULL, path TEXT NOT NULL, agent_id TEXT NOT NULL,
  kind TEXT NOT NULL, at INTEGER NOT NULL
);
-- A seat's ask_flight questions; answered_at is set by a message to the seat, or the run's end.
CREATE TABLE IF NOT EXISTS seat_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, run_id TEXT NOT NULL,
  text TEXT NOT NULL, at INTEGER NOT NULL, answered_at INTEGER
);
-- A question that left Needs you without an answer, with why (returned, withdrawn, or a fact).
CREATE TABLE IF NOT EXISTS question_closures (
  key TEXT NOT NULL, ask_at INTEGER NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL,
  by TEXT NOT NULL, question TEXT NOT NULL, ticket TEXT, operator INTEGER NOT NULL,
  at INTEGER NOT NULL, PRIMARY KEY (key, ask_at)
);
CREATE INDEX IF NOT EXISTS question_closures_at ON question_closures(at);
-- Failures of the mc tools that the operator is told of (Needs you, until acked).
CREATE TABLE IF NOT EXISTS crew_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, run_id TEXT, text TEXT NOT NULL,
  at INTEGER NOT NULL, acked INTEGER NOT NULL DEFAULT 0
);
-- What the FLIGHT seat decided, with its basis ("Decided without you").
CREATE TABLE IF NOT EXISTS flight_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, seat_id TEXT,
  target_run_id TEXT, ref TEXT, question_id INTEGER, about TEXT NOT NULL, decision TEXT NOT NULL,
  basis TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS flight_decisions_at ON flight_decisions(at);
-- The test lock's held calls (one row per tool call of the holding run), so a restart restores them.
CREATE TABLE IF NOT EXISTS test_lock_holds (
  run_id TEXT NOT NULL, tool_use_id TEXT NOT NULL, seat_id TEXT NOT NULL, command TEXT NOT NULL,
  since INTEGER NOT NULL, PRIMARY KEY (run_id, tool_use_id)
);
-- One row per hold, retained for QA_RETENTION_DAYS. outcome: pass or fail from the Post hook event.
CREATE TABLE IF NOT EXISTS test_lock_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, seat_id TEXT NOT NULL,
  command TEXT NOT NULL, queued_at INTEGER NOT NULL, started_at INTEGER NOT NULL,
  ended_at INTEGER, outcome TEXT
);
CREATE INDEX IF NOT EXISTS test_lock_runs_started ON test_lock_runs(started_at);
-- A configured check a seat ran in its clone, on the head it ran against (the push gate reads it).
CREATE TABLE IF NOT EXISTS check_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, command TEXT NOT NULL,
  invoked_command TEXT, head_sha TEXT NOT NULL, ok INTEGER NOT NULL, exit_code INTEGER, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS check_runs_run ON check_runs(run_id, command, head_sha);
-- The last keeper line the hub acted on, per run: the next hub replays from here.
CREATE TABLE IF NOT EXISTS keeper_cursors (
  run_id TEXT PRIMARY KEY, spawn TEXT NOT NULL, line INTEGER NOT NULL, rate_limited_until INTEGER
);
-- FLIGHT's briefs on Needs-you items (the newest row per key shows); options is JSON.
CREATE TABLE IF NOT EXISTS briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, context TEXT NOT NULL,
  recommendation TEXT NOT NULL, options TEXT NOT NULL, basis TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS item_discussions (
  id TEXT PRIMARY KEY, item_key TEXT NOT NULL, version TEXT NOT NULL, messages TEXT NOT NULL, sent TEXT NOT NULL DEFAULT '[]',
  UNIQUE(item_key, version)
);
CREATE INDEX IF NOT EXISTS briefs_key ON briefs(key);
CREATE INDEX IF NOT EXISTS briefs_at ON briefs(at);
-- The template profile FLIGHT or the planner chose for a ticket, with the reason; the latest wins.
CREATE TABLE IF NOT EXISTS profile_overrides (
  repo_id TEXT NOT NULL, issue INTEGER NOT NULL, profile TEXT NOT NULL, reason TEXT NOT NULL,
  by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (repo_id, issue)
);
-- Cards FLIGHT holds in Backlog behind an open PR; released_at is set when the card is promoted again.
CREATE TABLE IF NOT EXISTS holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL, waits_on INTEGER NOT NULL,
  basis TEXT NOT NULL, at INTEGER NOT NULL, released_at INTEGER, seen INTEGER NOT NULL DEFAULT 0,
  told_state TEXT
);
CREATE INDEX IF NOT EXISTS holds_ref ON holds(ref);
-- FLIGHT's living brief: one row per crew session and section.
CREATE TABLE IF NOT EXISTS flight_brief (
  session_id TEXT NOT NULL, section TEXT NOT NULL, text TEXT NOT NULL,
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY (session_id, section)
);
CREATE TABLE IF NOT EXISTS flight_memory (
  repo_id TEXT NOT NULL, topic TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
  source TEXT NOT NULL, author TEXT NOT NULL, topic_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (repo_id, topic_key)
);
CREATE TABLE IF NOT EXISTS flight_ledger (
  session_id TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  updated_at INTEGER NOT NULL, entry TEXT NOT NULL, PRIMARY KEY(session_id, key)
);
-- What a ledger entry watches; the hub marks changed_at when the target moves, FLIGHT's wake stamps read_at.
CREATE TABLE IF NOT EXISTS flight_pointers (
  session_id TEXT NOT NULL, entry_key TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
  changed_at INTEGER, change TEXT, read_at INTEGER, changed_seq INTEGER, read_seq INTEGER,
  PRIMARY KEY (session_id, entry_key, kind, target)
);
CREATE INDEX IF NOT EXISTS flight_pointers_target ON flight_pointers(kind, target);
CREATE TABLE IF NOT EXISTS flight_watch (
  session_id TEXT NOT NULL, id TEXT NOT NULL, entry TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE TABLE IF NOT EXISTS flight_plans (
  session_id TEXT NOT NULL, id TEXT NOT NULL, entry TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
);
-- One row per FLIGHT wake: the run it woke and the fact categories that woke it.
CREATE TABLE IF NOT EXISTS flight_wakes (
  run_id TEXT NOT NULL, at INTEGER NOT NULL, reasons TEXT NOT NULL, PRIMARY KEY (run_id, at)
);
CREATE TABLE IF NOT EXISTS flight_incoming (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, arrival_id TEXT NOT NULL, version TEXT NOT NULL,
  at INTEGER NOT NULL, entry TEXT NOT NULL, UNIQUE (source, arrival_id, version)
);
-- The operator's GitHub notification threads (read-only copy); handled_* closes a thread here.
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, subject_type TEXT NOT NULL, title TEXT NOT NULL,
  number INTEGER, reason TEXT NOT NULL, url TEXT NOT NULL, author TEXT, snippet TEXT,
  updated_at INTEGER NOT NULL, last_read_at INTEGER, unread INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL, handled_at INTEGER, handled_how TEXT, handled_through INTEGER
);
-- Waste alarms: spend that bought no progress, one per check and subject while it stands. Open until
-- the cause ends (closed_at) or FLIGHT or the operator resolves the hold with a basis (resolved_at).
CREATE TABLE IF NOT EXISTS waste_alarms (
  id INTEGER PRIMARY KEY AUTOINCREMENT, check_id TEXT NOT NULL, subject TEXT NOT NULL, repo_id TEXT,
  ticket TEXT, seat_id TEXT, run_id TEXT, level INTEGER NOT NULL, evidence TEXT NOT NULL,
  opened_at INTEGER NOT NULL, closed_at INTEGER, resolved_at INTEGER, basis TEXT
);
CREATE INDEX IF NOT EXISTS waste_alarms_subject ON waste_alarms(check_id, subject, opened_at);
-- Worktree paths a crew start is making (worktree add, then the install); one still here at the
-- next start was left half-made, and is removed and made again.
CREATE TABLE IF NOT EXISTS checkouts_pending (path TEXT PRIMARY KEY, at INTEGER NOT NULL);
-- Hub-owned ticket waits do not change the GitHub Project Status field. They make the ticket
-- unowned while it waits, so a free seat can take other Ready work.
CREATE TABLE IF NOT EXISTS ticket_waits (
  repo_id TEXT NOT NULL, issue INTEGER NOT NULL, reason TEXT NOT NULL, frees_when TEXT NOT NULL,
  at INTEGER NOT NULL, PRIMARY KEY (repo_id, issue)
);
CREATE TABLE IF NOT EXISTS attention_materials (
  id TEXT PRIMARY KEY, item_key TEXT NOT NULL, packet TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attention_materials_item ON attention_materials(item_key, id DESC);
`;
