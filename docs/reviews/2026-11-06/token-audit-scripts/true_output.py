import json, sys, os, glob, time, collections
root, days = sys.argv[1], float(sys.argv[2]); cut = time.time() - days*86400
R = collections.defaultdict(collections.Counter)
for f in glob.glob(os.path.join(root, '*.jsonl')):
    if os.path.getmtime(f) < cut: continue
    s = os.path.basename(f).split(':')[0]
    role = 'FLIGHT' if s.startswith('flight') else 'reviewer' if s.startswith('retro') else 'planner' if s.startswith('fao') else 'developers'
    last = 0; n = 0
    for line in open(f, errors='replace'):
        if '"type":"result"' not in line: continue
        try: ev = json.loads(line)
        except Exception: continue
        if ev.get('type') != 'result': continue
        u = ev.get('usage') or {}
        R[role]['cr'] += u.get('cache_read_input_tokens') or 0; R[role]['cw'] += u.get('cache_creation_input_tokens') or 0
        R[role]['out'] += u.get('output_tokens') or 0; R[role]['in'] += u.get('input_tokens') or 0
        R[role]['turns'] += ev.get('num_turns') or 0
        last = ev.get('total_cost_usd') or last; n += 1
    if n: R[role]['usd'] += last; R[role]['runs'] += 1
tot = sum(v['usd'] for v in R.values())
print(f"{'role':11}{'runs':>5}{'usd':>7}{'share':>7}{'cache rd M':>11}{'cache wr M':>11}{'out M':>7}{'| by type (0.1/1.25/5 ratios): read':>36}{'write':>7}{'output':>8}{'usd/run':>9}")
for role, v in sorted(R.items(), key=lambda kv: -kv[1]['usd']):
    a, b, c = v['cr']*0.1, v['cw']*1.25, v['out']*5; t = a+b+c+v['in']
    print(f"{role:11}{v['runs']:>5}{v['usd']:>7.0f}{v['usd']/tot:>7.0%}{v['cr']/1e6:>11.0f}{v['cw']/1e6:>11.1f}{v['out']/1e6:>7.2f}{a/t:>36.0%}{b/t:>7.0%}{c/t:>8.0%}{v['usd']/max(1,v['runs']):>9.2f}")
print('total usd', round(tot))
