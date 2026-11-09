import json, sys, os, glob, time, collections
root = sys.argv[1]
cut = time.time() - 86400
calls = collections.Counter(); chars = collections.Counter(); inchars = collections.Counter()
runs = collections.defaultdict(collections.Counter)
files = [f for f in glob.glob(os.path.join(root, '*.jsonl')) if os.path.getmtime(f) > cut]
big = []
for f in files:
    seat = os.path.basename(f).split(':')[0]
    pending = {}
    try:
        for line in open(f, errors='replace'):
            if 'mcp__mc__' not in line and 'tool_result' not in line: continue
            try: ev = json.loads(line)
            except Exception: continue
            msg = ev.get('message') or {}
            content = msg.get('content')
            if not isinstance(content, list): continue
            for c in content:
                if not isinstance(c, dict): continue
                if c.get('type') == 'tool_use' and str(c.get('name','')).startswith('mcp__mc__'):
                    n = c['name'][len('mcp__mc__'):]
                    pending[c.get('id')] = n
                    calls[n] += 1; runs[seat][n] += 1
                    inchars[n] += len(json.dumps(c.get('input', {})))
                elif c.get('type') == 'tool_result' and c.get('tool_use_id') in pending:
                    n = pending.pop(c['tool_use_id'])
                    body = c.get('content')
                    size = len(body) if isinstance(body, str) else sum(len(x.get('text','')) for x in (body or []) if isinstance(x, dict))
                    chars[n] += size
                    if n == 'comms_read': big.append((size, seat))
    except Exception as e:
        print('skip', f, e)
print('transcripts in 24h:', len(files))
print(f"{'tool':22}{'calls':>6}{'in chars':>10}{'result chars':>14}{'avg result':>12}{'~tokens':>9}")
for n, k in sorted(calls.items(), key=lambda x: -chars[x[0]]):
    print(f"{n:22}{k:>6}{inchars[n]:>10}{chars[n]:>14}{chars[n]//max(k,1):>12}{(chars[n]+inchars[n])//4:>9}")
print('comms_read result sizes:', sorted((s for s,_ in big), reverse=True)[:12])
print('comms_read by seat:', {s: runs[s]['comms_read'] for s in runs if runs[s]['comms_read']})
print('comms_inbox by seat:', {s: runs[s]['comms_inbox'] for s in runs if runs[s]['comms_inbox']})
