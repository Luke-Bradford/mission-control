// Spike: Codex limits. (1) `codex app-server` over stdio: initialize, then
// account/rateLimits/read. (2) fallback: rate_limits of the last token_count
// event in the newest ~/.codex/sessions/**/rollout-*.jsonl that has one.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Never print identifiers: drop accountId and reset-credit ids (keep the count).
function redact(r) {
  const { accountId, rateLimitResetCredits, ...rest } = r ?? {};
  return { ...rest, rateLimitResetCredits: { availableCount: rateLimitResetCredits?.availableCount } };
}

function appServer() {
  return new Promise((resolve) => {
    const p = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const timer = setTimeout(() => { p.kill(); resolve({ error: 'timeout' }); }, 20_000);
    const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
    p.on('error', (e) => { clearTimeout(timer); resolve({ error: String(e) }); });
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (m.id === 2) {
          clearTimeout(timer); p.kill(); resolve(redact(m.result ?? { error: m.error }));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cc-spike', title: 'cc-spike', version: '0.0.0' } } });
  });
}

function walk(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/^rollout-.*\.jsonl$/.test(e.name)) out.push(p);
  }
  return out;
}

function rollout() {
  const files = walk(join(homedir(), '.codex/sessions')).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"token_count"')).reverse();
    for (const l of lines) {
      try {
        const rl = JSON.parse(l)?.payload?.rate_limits;
        if (rl) return { file: f.split('/').pop(), rate_limits: rl };
      } catch { /* skip */ }
    }
  }
  return { error: 'no token_count with rate_limits' };
}

console.log('app-server:', JSON.stringify(await appServer(), null, 1));
console.log('rollout:', JSON.stringify(rollout(), null, 1));
