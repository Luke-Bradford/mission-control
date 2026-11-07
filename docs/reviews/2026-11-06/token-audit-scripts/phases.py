import json, sys, os, glob, time, collections, re, statistics
root = sys.argv[1]; cut = time.time() - 7*86400
dev = collections.Counter(); per_run_tail = []; fl_first = []; fl_heads = collections.Counter(); rounds = []
for f in glob.glob(os.path.join(root, '*.jsonl')):
    if os.path.getmtime(f) < cut: continue
    b = os.path.basename(f); isdev = re.match(r'(guido|inco)-\d', b); isfl = b.startswith('flight')
    if not (isdev or isfl): continue
    seen = set(); reported = 0; before = after = 0; first_user = None; n_reports = 0
    for line in open(f, errors='replace'):
        if '"message"' not in line: continue
        try: ev = json.loads(line)
        except Exception: continue
        m = ev.get('message') or {}
        if not isinstance(m, dict): continue
        c = m.get('content')
        if ev.get('type') == 'user' and first_user is None:
            first_user = c if isinstance(c, str) else ' '.join(x.get('text', '') for x in (c or []) if isinstance(x, dict) and x.get('type') == 'text')
        if ev.get('type') == 'assistant' and m.get('id') and isinstance(m.get('usage'), dict):
            if m['id'] not in seen:
                seen.add(m['id']); cr = m['usage'].get('cache_read_input_tokens', 0) + m['usage'].get('cache_creation_input_tokens', 0)
                if reported: after += cr
                else: before += cr
            for x in c or []:
                if isinstance(x, dict) and x.get('type') == 'tool_use' and x.get('name') == 'mcp__mc__report_evidence':
                    reported = 1; n_reports += 1
    if isdev and seen:
        dev['before first report'] += before; dev['after first report'] += after; dev['runs'] += 1; dev['runs with a report'] += bool(n_reports)
        if before + after: per_run_tail.append(after / (before + after))
        rounds.append(n_reports)
    if isfl and first_user:
        fl_first.append(len(first_user))
        for h in re.findall(r'^(#{1,3} [^\n]{0,60}|\[[A-Za-z ]{3,30}\][^\n]{0,40})', first_user, re.M)[:400]: fl_heads[h[:50]] += 1
        if len(fl_first) == 1: sample = first_user
t = dev['before first report'] + dev['after first report']
print(f"developer runs {dev['runs']} ({dev['runs with a report']} reported). Context read before the first report: {dev['before first report']/1e6:.0f}M ({dev['before first report']/t:.0%}); after it (CI fixes, rework, waiting): {dev['after first report']/1e6:.0f}M ({dev['after first report']/t:.0%})")
per_run_tail.sort(); rounds.sort()
print('share of a run spent after its first report: median %.0f%%, p75 %.0f%%; reports per run median %d, p90 %d' % (100*per_run_tail[len(per_run_tail)//2], 100*per_run_tail[int(len(per_run_tail)*.75)], rounds[len(rounds)//2], rounds[int(len(rounds)*.9)]))
fl_first.sort()
print('FLIGHT first message of a run: chars median', fl_first[len(fl_first)//2], 'max', fl_first[-1], 'runs', len(fl_first))
# section sizes in one sample
parts = re.split(r'\n(?=#{1,3} )', sample)
big = sorted(((len(p), p.split('\n', 1)[0][:70]) for p in parts), reverse=True)[:14]
print('one FLIGHT first message,', len(sample), 'chars; largest parts:')
for n, h in big: print(f'   {n:>7}  {h}')
