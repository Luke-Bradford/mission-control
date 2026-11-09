import json, sys, os, glob, time, collections, difflib
root = sys.argv[1]; cut = time.time() - 86400
runs = collections.defaultdict(list)
for f in glob.glob(os.path.join(root, '*.jsonl')):
    if os.path.getmtime(f) < cut: continue
    for line in open(f, errors='replace'):
        if 'mcp__mc__report_evidence' not in line: continue
        try: ev = json.loads(line)
        except Exception: continue
        for c in (ev.get('message') or {}).get('content') or []:
            if isinstance(c, dict) and c.get('type') == 'tool_use' and c.get('name') == 'mcp__mc__report_evidence':
                runs[os.path.basename(f)].append(c.get('input', {}))
calls = sum(len(v) for v in runs.values())
print('runs', len(runs), 'calls', calls, 'calls per run: median', sorted(len(v) for v in runs.values())[len(runs)//2], 'max', max(len(v) for v in runs.values()))
tot = collections.Counter(); same = collections.Counter(); pairs = 0; note_ratio = []
dw_items_total = dw_items_same = 0
for f, cs in runs.items():
    prev = None
    for inp in cs:
        for k in ('doneWhen', 'tests', 'testsAdded', 'note'):
            tot[k] += len(json.dumps(inp.get(k, '')))
        if prev is not None:
            pairs += 1
            for k in ('doneWhen', 'tests', 'testsAdded'):
                if json.dumps(inp.get(k, '')) == json.dumps(prev.get(k, '')): same[k] += len(json.dumps(inp.get(k, '')))
            a, b = inp.get('doneWhen') or [], prev.get('doneWhen') or []
            if isinstance(a, list) and isinstance(b, list):
                pb = {json.dumps(x, sort_keys=True) for x in b}
                for x in a:
                    dw_items_total += len(json.dumps(x)); 
                    if json.dumps(x, sort_keys=True) in pb: dw_items_same += len(json.dumps(x))
            note_ratio.append(difflib.SequenceMatcher(None, str(prev.get('note', '')), str(inp.get('note', '')), autojunk=False).ratio())
        prev = inp
print('chars written by field:', dict(tot))
print('chars identical to the previous call, whole field:', dict(same))
print('doneWhen items identical to one in the previous call: %d of %d chars' % (dw_items_same, dw_items_total))
note_ratio.sort()
print('note text shared with previous call: median %.2f, over half shared: %d of %d' % (note_ratio[len(note_ratio)//2], sum(r > .5 for r in note_ratio), len(note_ratio)))
ex = max(runs.items(), key=lambda kv: len(kv[1]))
print('example run', ex[0], 'calls', len(ex[1])); print(json.dumps(ex[1][0].get('doneWhen'))[:500])
