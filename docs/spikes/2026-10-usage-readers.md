# Spike: reading account limits with no agent running

Date: 2026-10-17. Scripts: `spikes/usage-readers/`. Feeds Task 12.

Ruling R2 applied: the Keychain token was never read by this spike. The Claude OAuth request is
derived from source; live verification used the existing `claude_usage.py` (prints only an integer %).

## Fallback order Task 12 must use

- **Claude:** OAuth usage endpoint -> latest `rate_limit_event.rate_limit_info.unifiedWindows` from a transcript.
- **Codex:** `codex app-server` `account/rateLimits/read` -> latest rollout `token_count.rate_limits`.

Observed today: the Claude OAuth endpoint was **not readable** from this shell (`claude_usage.py` printed nothing, exit 1;
studio `/api/quota` reported `unavailable.claude = "rate_limited"`, i.e. upstream 429, #777). The fallback is therefore
load-bearing, not theoretical. The engine dashboard still served a warm cached live value.

## Claude: OAuth usage endpoint (primary)

Request (`engine/lib/claude_usage.py:33-36,123-127`): `GET https://api.anthropic.com/api/oauth/usage`, headers
`Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20`, `Accept: application/json`; timeout 3s; do not follow redirects
(`loop/claude_usage.py` `_NoRedirect`, the token would be replayed). Token source: macOS Keychain service
`Claude Code-credentials`, JSON `claudeAiOauth.accessToken` (`loop/claude_usage.py:162-168`). Poll sparingly: unbounded polling self-inflicts a 429.

| source | field path | meaning | example value |
|---|---|---|---|
| oauth usage | `five_hour.utilization` | 5h window used (`engine/lib/claude_usage.py:195,177`) | PERCENT, 0-100+ (e.g. `48.0` = 48%); not a fraction |
| oauth usage | `five_hour.resets_at` | 5h reset, ISO-8601 string (`:180`, parsed by `_iso_to_epoch`) | `"2026-07-03T19:10:00+00:00"` |
| oauth usage | `seven_day.utilization` | 7d window used (`loop/claude_usage.py:269-272`) | PERCENT, e.g. `45.0` |
| oauth usage | `seven_day.resets_at` | 7d reset, ISO-8601 | ISO string |
| oauth usage | `seven_day.overage` / `five_hour.overage` | optional truthy flag (`:184`) | `true` |

Overage (>100) passes through uncapped. Requires: Keychain credential only (a prior `claude` login); **no agent session needed**.
Live verification: `python3 loop/claude_usage.py` -> no output, exit 1 (unreadable; likely the 429 above, cause not distinguishable because the reader swallows all errors). Response shape is therefore from source, not an observed live body.

## Claude: transcript fallback

Where `rate_limit_event` lives (grep counts, 2026-10-17):

- `~/code/.shop-app-autonomy/var/autonomy/iteration-*.log`: yes (10-15 events per recent file).
- `~/code/studio-loop/logs/fire.*.log`: yes (4-11 events per recent file), identical shape.
- `~/.claude/projects/**/<session>.jsonl` (standard interactive transcripts): **no**. No file contains a `"type":"rate_limit_event"` line and none contains `unifiedWindows` as an event; the only grep hits were text of this task's own session. Interactive sessions do not persist the event.

So the event comes only from stream-json (headless `-p --output-format stream-json`) output captured to log files. Task 12 should scan, newest mtime first across both globs combined, the iteration logs and the fire logs, and take the last parseable `rate_limit_event` line with `unifiedWindows` in the first file that has one. Not scanning `~/.claude/projects`. Any other headless runner that captures stream-json would need its log dir added to the list.

Line `type: "rate_limit_event"`. Observed line (trimmed):
`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1792245600,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.07,"resetsAt":1792245600},"seven_day":{"utilization":0.45,"resetsAt":1792548000}}}}`

| source | field path | meaning | example value |
|---|---|---|---|
| transcript | `rate_limit_info.unifiedWindows.five_hour.utilization` | 5h used | FRACTION 0-1 (`0.07` = 7%) |
| transcript | `rate_limit_info.unifiedWindows.five_hour.resetsAt` | 5h reset | epoch seconds `1792245600` |
| transcript | `rate_limit_info.unifiedWindows.seven_day.utilization` | 7d used | FRACTION 0-1 (`0.45`) |
| transcript | `rate_limit_info.unifiedWindows.seven_day.resetsAt` | 7d reset | epoch seconds `1792548000` |

Units differ from the OAuth endpoint (fraction vs percent; epoch vs ISO string). Normalise in Task 12. Works with **no agent running** (reads
files on disk) but is only as fresh as the last agent turn that emitted an event; staleness must be surfaced (age of the log line).

## Claude: local engine endpoints (already-running services; not for the new hub's primary path)

| source | field path | meaning | example value |
|---|---|---|---|
| `:8787 /api/state` | `account.claude.five_hour.utilization` | 5h used | FRACTION 0-1, `0.08` |
| `:8787 /api/state` | `account.claude.five_hour.resets_at` | reset | epoch s, `1792245599` |
| `:8787 /api/state` | `account.claude.seven_day.utilization` / `.resets_at` | 7d used / reset | `0.45` / `1792547999` |
| `:8787 /api/state` | `account.claude.{five_hour,seven_day}.forecast.{projected_exhaust_epoch,exhausts_before_reset}` | engine forecast | `1792315436` / `false` |
| `:8787 /api/state` | `account.claude.source` | provenance | `"live"` |
| `:8787 /api/state` | `account.codex.seven_day.pct` / `.resets_at` | Codex 7d used | PERCENT `14.0` / epoch `1792649881` |
| `:8787 /api/state` | `account.codex.five_hour` | empty object when plan has no 5h window | `{}` |
| `:8787 /api/state` | `account.codex.plan` | plan | `"prolite"` |
| `:8788 /api/quota` | `account.claude` | null when unavailable | `null` |
| `:8788 /api/quota` | `unavailable.claude` | reason | `"rate_limited"` |

These need the old engine/studio processes running, so they are not a hub dependency. The 8787 value is a warm cache that survives upstream 429s. `account.{five_hour,seven_day}.{sessions,tokens}` are local token counts, not limits.

## Codex: `codex app-server` (primary)

Spawn `codex app-server` (codex-cli 0.154.0), newline-delimited JSON-RPC on stdio. Handshake: send
`{"id":1,"method":"initialize","params":{"clientInfo":{"name":..,"title":..,"version":..}}}`, then notification `{"method":"initialized"}`, then
`{"id":2,"method":"account/rateLimits/read"}`. Worked first try; `result` shape:

| source | field path | meaning | example value |
|---|---|---|---|
| app-server | `result.rateLimits.primary.usedPercent` | primary window used | PERCENT `14` |
| app-server | `result.rateLimits.primary.windowDurationMins` | window length; classify 5h vs 7d by this | `10080` (= 7d) |
| app-server | `result.rateLimits.primary.resetsAt` | reset | epoch s `1792649881` |
| app-server | `result.rateLimits.secondary` | second window (same shape) or null | `null` on this plan |
| app-server | `result.rateLimits.planType` | plan | `"prolite"` |
| app-server | `result.rateLimits.credits.{hasCredits,unlimited,balance}` | credits | `false`/`false`/`"0"` |
| app-server | `result.rateLimits.rateLimitReachedType`, `.spendControlReached` | limit hit flags | `null`, `false` |
| app-server | `result.rateLimitsByLimitId.<limitId>` | same object keyed by id | key `codex` |
| app-server | `result.rateLimitResetCredits.availableCount` | free resets (items carry ids; do not log) | `3` |

Window identification (applies to app-server `windowDurationMins` and rollout `window_minutes`; treat `primary`/`secondary` as an unordered pair): `300` -> 5h, `10080` -> 7d. Any other value (a `0` was seen once in history) is ignored and logged. Across all local rollouts only 300 and 10080 occur. `primary` is the 7d window on this plan with no 5h window: never assume primary = 5h.

`usedPercent` / `used_percent`: a number 0-100; treat it as possibly fractional. All values seen were whole numbers (`13.0`, `14.0`, `12.0` in rollouts, `4.0` once in `secondary`); no fractional value was observed. `secondary` was null in the live app-server response and in the newest rollouts, but a non-null `secondary` (`{used_percent, window_minutes, resets_at}`) does appear in some older rollouts, so handle both. Works with **no agent session running** (spawns its own short-lived server). The result also contains `accountId`; the script strips it.

## Codex: rollout fallback

Source: last `token_count` event in the newest `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` that has one (the single newest file can lack any `token_count`, so scan newest-first). Path in the line: `payload.rate_limits`.

| source | field path | meaning | example value |
|---|---|---|---|
| rollout | `payload.rate_limits.primary.used_percent` | primary used | PERCENT `14` |
| rollout | `payload.rate_limits.primary.window_minutes` | window length | `10080` |
| rollout | `payload.rate_limits.primary.resets_at` | reset | epoch s `1792649881` |
| rollout | `payload.rate_limits.secondary` | second window | `null` |
| rollout | `payload.rate_limits.plan_type` | plan | `"prolite"` |

snake_case twin of the app-server shape. Works with no agent running, but stale to the last Codex turn.

## Fall-through and staleness rules (controller ruling)

- Fall to the next source in the order above on an error, a non-2xx response (including 429), or a null or missing window.
- A sample is stale when older than 2x the usage poll interval: 60 min at 30-min polling. Stale samples are not used.
- A transcript or rollout sample whose `resetsAt` / `resets_at` is already in the past is discarded: that window has reset and the figure no longer applies.
- Per-window, not all-or-nothing: the engine reader requires both windows valid (`_build` in `engine/lib/claude_usage.py:189-199` returns None if either is missing). Control Centre instead stores whichever windows are valid.

## Scripts

`claude-usage.mjs` (wrapper over `claude_usage.py`, R2), `local-endpoints.mjs`, `transcript-limits.mjs` (iteration logs only; Task 12 must also scan `fire.*.log`), `codex-ratelimits.mjs`. Run with `node <file>`; no dependencies.
