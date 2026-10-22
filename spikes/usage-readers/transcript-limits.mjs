// Spike: latest rate_limit_event.rate_limit_info.unifiedWindows from the newest
// Claude stream-json iteration log that has one. Works with no agent running.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = process.argv[2] ?? join(homedir(), 'code/.shop-app-autonomy/var/autonomy');
const logs = readdirSync(dir).filter((f) => /^iteration-.*\.log$/.test(f))
  .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
for (const { f } of logs) {
  const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.includes('rate_limit_event'));
  for (const l of lines.reverse()) {
    try {
      const w = JSON.parse(l)?.rate_limit_info?.unifiedWindows;
      if (w) { console.log(f, JSON.stringify(w)); process.exit(0); }
    } catch { /* partial line */ }
  }
}
console.log('no rate_limit_event found');
process.exitCode = 1;
