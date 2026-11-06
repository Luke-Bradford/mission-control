"""Usage of Claude Code sessions in one project folder, counted by event time. Read-only.

Usage: python3 -I controller_sessions.py <project session folder> <days>
Counts each assistant message once across all files (a resumed session can copy history), and only
messages whose own timestamp falls in the window. Main sessions and subagent files are reported apart.
"""
import json, sys, os, glob, time, collections
from datetime import datetime
root, days = sys.argv[1], float(sys.argv[2]); cut = time.time() - days * 86400
seen = {}; per = collections.defaultdict(lambda: collections.Counter()); peak = collections.Counter()
for f in glob.glob(os.path.join(root, '*.jsonl')) + glob.glob(os.path.join(root, '*', 'subagents', '*.jsonl')):
    if os.path.getmtime(f) < cut: continue
    kind = 'subagent' if os.sep + 'subagents' + os.sep in f else 'main'
    name = os.path.basename(f)[:12]
    with open(f, errors='replace') as fh:
        for line in fh:
            if '"usage"' not in line: continue
            try: ev = json.loads(line)
            except Exception: continue
            m = ev.get('message')
            if ev.get('type') != 'assistant' or not isinstance(m, dict) or not m.get('id') or not isinstance(m.get('usage'), dict): continue
            ts = ev.get('timestamp')
            try: t = datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
            except Exception: continue
            if t < cut or m['id'] in seen: continue
            u = m['usage']; seen[m['id']] = 1
            c = per[(kind, name)]
            c['calls'] += 1; c['cr'] += u.get('cache_read_input_tokens', 0); c['cw'] += u.get('cache_creation_input_tokens', 0)
            ctx = u.get('input_tokens', 0) + u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0)
            peak[(kind, name)] = max(peak[(kind, name)], ctx)
tot = collections.Counter()
for (kind, name), c in per.items():
    tot[kind + ' files'] += 1
    for k in ('calls', 'cr', 'cw'): tot[kind + ' ' + k] += c[k]
print(f"window {days:g} days, by event time; messages counted once across files")
for kind in ('main', 'subagent'):
    print(f"  {kind}: files {tot[kind + ' files']}, calls {tot[kind + ' calls']}, cache read {tot[kind + ' cr']/1e6:.0f}M, cache write {tot[kind + ' cw']/1e6:.1f}M")
for (kind, name), c in sorted(per.items(), key=lambda kv: -kv[1]['cr'])[:5]:
    print(f"  {name} {kind:8} calls {c['calls']:>5} peak context {peak[(kind, name)]/1e3:>5.0f}k cache read {c['cr']/1e6:>7.1f}M")
