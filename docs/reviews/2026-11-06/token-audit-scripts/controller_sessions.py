import json, sys, os, glob, time, collections
root = sys.argv[1]; cut = time.time() - 7*86400
tot = collections.Counter(); per = []
for f in glob.glob(os.path.join(root, '*.jsonl')) + glob.glob(os.path.join(root, '*', 'subagents', '*.jsonl')):
    if os.path.getmtime(f) < cut: continue
    seen = {}
    for line in open(f, errors='replace'):
        if '"usage"' not in line: continue
        try: ev = json.loads(line)
        except Exception: continue
        m = ev.get('message') or {}
        if ev.get('type') == 'assistant' and m.get('id') and isinstance(m.get('usage'), dict):
            u = m['usage']; p = seen.get(m['id'], (0, 0, 0, 0))
            seen[m['id']] = (u.get('cache_read_input_tokens', 0), u.get('cache_creation_input_tokens', 0), max(p[2], u.get('output_tokens', 0)), m.get('model', ''))
    if not seen: continue
    cr = sum(v[0] for v in seen.values()); cw = sum(v[1] for v in seen.values()); out = sum(v[2] for v in seen.values())
    sub = 'subagents' in f
    tot['cr'] += cr; tot['cw'] += cw; tot['out'] += out; tot['calls'] += len(seen); tot['files'] += 1; tot['sub_cr'] += cr if sub else 0
    per.append((cr, len(seen), max(v[0] + v[1] for v in seen.values()), os.path.basename(f)[:12], 'sub' if sub else 'main', collections.Counter(v[3] for v in seen.values()).most_common(1)[0][0]))
print('controller session files (7 days):', tot['files'], 'API calls', tot['calls'], f"cache read {tot['cr']/1e6:.0f}M (subagents {tot['sub_cr']/1e6:.0f}M), cache write {tot['cw']/1e6:.1f}M, output seen {tot['out']/1e6:.2f}M (undercounted)")
for cr, n, peak, name, kind, model in sorted(per, reverse=True)[:8]:
    print(f"  {name} {kind:4} {model[:22]:22} calls {n:>5} peak ctx {peak/1e3:>5.0f}k cache read {cr/1e6:>7.1f}M")
