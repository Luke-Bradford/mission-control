// Spike: Claude account usage. Thin wrapper over the existing engine reader.
//
// Ruling R2: this spike must NOT read the Keychain token itself (no
// `security find-generic-password`). The existing reader does the OAuth call
// (GET https://api.anthropic.com/api/oauth/usage, header
// `anthropic-beta: oauth-2025-04-20`) and prints ONLY an integer 7-day %.
// This wrapper shells out to it and prints that %. Task 12 implements the
// request itself; see docs/spikes/2026-10-usage-readers.md.
//
// Usage: node claude-usage.mjs <path to claude_usage.py>  (or set CLAUDE_USAGE_PY)
import { execFileSync } from 'node:child_process';

const script = process.argv[2] ?? process.env.CLAUDE_USAGE_PY;
if (!script) {
  console.error('usage: node claude-usage.mjs <path to claude_usage.py>  (or set CLAUDE_USAGE_PY)');
  process.exit(2);
}
try {
  const out = execFileSync('python3', [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`seven_day utilization: ${out.trim()}%`);
} catch (e) {
  console.log('unreadable (reader prints nothing and exits 1 on any failure, incl. upstream 429)');
  process.exitCode = 1;
}
