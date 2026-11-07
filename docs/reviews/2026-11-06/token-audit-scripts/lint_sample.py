import json, sys, os, glob, time, collections, re
root = sys.argv[1]; cut = time.time() - 2*86400
sizes = []; sample = None; kinds = collections.Counter()
for f in glob.glob(os.path.join(root, '*.jsonl')):
    if os.path.getmtime(f) < cut or not re.match(r'(guido|inco)-\d', os.path.basename(f)): continue
    pend = {}
    for line in open(f, errors='replace'):
        if 'pnpm' not in line and 'tool_result' not in line: continue
        try: ev = json.loads(line)
        except Exception: continue
        for c in (ev.get('message') or {}).get('content') or []:
            if not isinstance(c, dict): continue
            if c.get('type') == 'tool_use' and c.get('name') == 'Bash' and re.search(r'pnpm (-s )?lint', (c.get('input') or {}).get('command', '')):
                pend[c['id']] = c['input']['command']
            elif c.get('type') == 'tool_result' and c.get('tool_use_id') in pend:
                b = c.get('content'); t = b if isinstance(b, str) else ' '.join(x.get('text', '') for x in b if isinstance(x, dict))
                sizes.append(len(t))
                kinds['has "error"' if re.search(r'\berror\b', t) and 'Found 0 errors' not in t else 'no error word'] += 1
                kinds['mentions warnings'] += bool(re.search(r'warning', t, re.I))
                if sample is None and 6000 < len(t) < 30000: sample = (pend[c['tool_use_id']], t)
sizes.sort()
print('lint calls', len(sizes), 'median chars', sizes[len(sizes)//2], 'p90', sizes[int(len(sizes)*.9)], dict(kinds))
if sample: print('COMMAND:', sample[0][:200]); print('OUTPUT HEAD:', sample[1][:900]); print('...OUTPUT TAIL:', sample[1][-500:])
