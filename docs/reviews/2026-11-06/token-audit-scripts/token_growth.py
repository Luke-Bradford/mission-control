"""Attribute context growth (and its re-read carry) to sources. Read-only."""
import json, sys, os, glob, time, collections, statistics, re
root, days = sys.argv[1], float(sys.argv[2]); cut = time.time() - days * 86400
src = collections.defaultdict(lambda: collections.Counter())      # source -> added tokens, carry tokens, events
bash = collections.defaultdict(lambda: collections.Counter())
role_src = collections.defaultdict(lambda: collections.defaultdict(lambda: collections.Counter()))
compactions = collections.Counter(); ts_key = None
flight_ctx = []; flight_calls_per_wake = []; flight_min = []
seat_ctx_q = collections.defaultdict(list)
late = collections.Counter()   # cache reads by position in run
def cls(cmd):
    cmd = cmd.strip()
    cmd = re.sub(r'^(cd\s+\S+\s*(&&|;)\s*)+', '', cmd)
    w = cmd.split()
    if not w: return '?'
    if w[0] in ('pnpm', 'npm', 'npx'):
        rest = [x for x in w[1:4] if not x.startswith('-')]
        return ' '.join([w[0]] + rest[:2])
    if w[0] in ('git', 'gh'): return ' '.join(w[:2])
    return w[0][:20]
files = [f for f in glob.glob(os.path.join(root, '*.jsonl')) if os.path.getmtime(f) > cut]
for f in files:
    s = os.path.basename(f).split(':')[0]
    role = 'FLIGHT' if s.startswith('flight') else 'reviewer' if s.startswith('retro') else 'planner' if s.startswith('fao') else 'developer'
    calls = []   # dict(ctx, cw, cr, incoming=[(source, chars, bashclass)], prev_out_chars)
    seen = {}; pending = {}; incoming = []; out_chars = 0; cur = None; wake_calls = 0
    try:
        for line in open(f, errors='replace'):
            if '"message"' not in line: continue
            try: ev = json.loads(line)
            except Exception: continue
            t = ev.get('type'); msg = ev.get('message') or {}; content = msg.get('content')
            if t == 'assistant' and msg.get('id') and isinstance(msg.get('usage'), dict):
                mid = msg['id']; u = msg['usage']
                if mid not in seen:
                    ctx = u.get('input_tokens', 0) + u.get('cache_creation_input_tokens', 0) + u.get('cache_read_input_tokens', 0)
                    cur = dict(ctx=ctx, cw=u.get('cache_creation_input_tokens', 0), cr=u.get('cache_read_input_tokens', 0), incoming=incoming, prev_out=out_chars)
                    calls.append(cur); seen[mid] = cur; incoming = []; out_chars = 0; wake_calls += 1
                if isinstance(content, list):
                    for c in content:
                        if not isinstance(c, dict): continue
                        if c.get('type') == 'tool_use':
                            inp = c.get('input', {}); out_chars += len(json.dumps(inp))
                            pending[c.get('id')] = (c.get('name', '?'), cls(inp.get('command', '')) if c.get('name') == 'Bash' else None)
                        elif c.get('type') == 'text': out_chars += len(c.get('text', ''))
                        elif c.get('type') == 'thinking': out_chars += len(c.get('thinking', '')) + len(c.get('signature', '')) * 0
            elif t == 'user':
                if isinstance(content, str):
                    incoming.append(('hub or operator line', len(content), None))
                    if role == 'FLIGHT' and wake_calls: flight_calls_per_wake.append(wake_calls); wake_calls = 0
                elif isinstance(content, list):
                    for c in content:
                        if not isinstance(c, dict): continue
                        if c.get('type') == 'tool_result':
                            name, bc = pending.pop(c.get('tool_use_id'), ('?', None))
                            body = c.get('content'); img = False
                            if isinstance(body, str): size = len(body)
                            else:
                                size = sum(len(x.get('text', '')) for x in (body or []) if isinstance(x, dict))
                                img = any(isinstance(x, dict) and x.get('type') == 'image' for x in (body or []))
                            incoming.append((name.replace('mcp__mc__', 'mc ') + (' [image]' if img else ''), max(size, 1), bc))
                        elif c.get('type') == 'text':
                            incoming.append(('hub or operator line', len(c.get('text', '')), None))
                            if role == 'FLIGHT' and wake_calls: flight_calls_per_wake.append(wake_calls); wake_calls = 0
    except Exception as e:
        print('skip', os.path.basename(f), e); continue
    n = len(calls)
    if not n: continue
    if role == 'FLIGHT':
        flight_ctx += [c['ctx'] for c in calls]; flight_min.append(min(c['ctx'] for c in calls))
    seat_ctx_q[role] += [c['ctx'] for c in calls]
    for i, c in enumerate(calls):
        late['first third' if i < n/3 else 'middle third' if i < 2*n/3 else 'last third'] += c['cr']
        if i == 0:
            src['start of run (system, tools, role, ticket)']['added'] += c['ctx']; src['start of run (system, tools, role, ticket)']['carry'] += c['ctx'] * n
            role_src[role]['start of run']['carry'] += c['ctx'] * n
            continue
        delta = c['ctx'] - calls[i-1]['ctx']
        if delta < -5000: compactions[role] += 1; continue
        if delta <= 0: continue
        own = min(delta, c['prev_out'] // 4); rest = delta - own
        def add(name, tok, bc=None):
            src[name]['added'] += tok; src[name]['carry'] += tok * (n - i); src[name]['events'] += 1
            role_src[role][name]['carry'] += tok * (n - i)
            if bc: bash[bc]['added'] += tok; bash[bc]['carry'] += tok * (n - i); bash[bc]['events'] += 1
        add('agent\'s own earlier output (commands, reports, text)', own)
        inc = c['incoming']
        if not inc: add('unattributed (thinking carried, reminders)', rest)
        else:
            tot = sum(x[1] for x in inc)
            for name, ch, bc in inc: add(name, rest * ch // tot, bc)
allcarry = sum(v['carry'] for v in src.values())
print(f'transcripts {len(files)}; total context read across all calls (carry): {allcarry/1e6:.0f}M tokens')
print(f"\n{'source of context':52}{'events':>7}{'added M':>9}{'re-read M':>10}{'share':>7}{'avg added':>10}")
for name, v in sorted(src.items(), key=lambda kv: -kv[1]['carry'])[:20]:
    print(f"{name[:51]:52}{v['events']:>7}{v['added']/1e6:>9.1f}{v['carry']/1e6:>10.0f}{v['carry']/allcarry:>7.0%}{v['added']//max(1,v['events']):>10}")
print('\n== Bash by command (tokens added to context, and re-read)')
bt = sum(v['carry'] for v in bash.values())
for name, v in sorted(bash.items(), key=lambda kv: -kv[1]['carry'])[:16]:
    print(f"  {name[:30]:32}{v['events']:>6} calls {v['added']/1e6:>6.2f}M added {v['carry']/1e6:>7.0f}M re-read {v['carry']/bt:>5.0%} avg {v['added']//max(1,v['events']):>6}")
print('\n== by role: top sources of re-read')
for role, d in role_src.items():
    tot = sum(v['carry'] for v in d.values())
    print(f"  {role} ({tot/1e6:.0f}M):", ', '.join(f"{k[:34]} {v['carry']/tot:.0%}" for k, v in sorted(d.items(), key=lambda kv: -kv[1]['carry'])[:6]))
print('\n== context size per call (k tokens): median / p90')
for role, xs in seat_ctx_q.items():
    xs.sort(); print(f"  {role:10} {xs[len(xs)//2]/1e3:.0f}k / {xs[int(len(xs)*.9)]/1e3:.0f}k  over {len(xs)} calls")
if flight_ctx:
    flight_calls_per_wake.sort()
    print(f"FLIGHT: lowest context in a run median {statistics.median(flight_min)/1e3:.0f}k; calls per wake median {flight_calls_per_wake[len(flight_calls_per_wake)//2] if flight_calls_per_wake else 0}, wakes seen {len(flight_calls_per_wake)}")
print('cache re-reads by position in the run:', {k: f"{v/sum(late.values()):.0%}" for k, v in late.items()})
print('context drops over 5k (compaction or reset):', dict(compactions))
