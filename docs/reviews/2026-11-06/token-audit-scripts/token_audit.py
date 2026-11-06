"""Token accounting from Claude seat transcripts (stream-json). Read-only."""
import json, sys, os, glob, time, collections, statistics
root, days = sys.argv[1], float(sys.argv[2])
cut = time.time() - days * 86400
W = dict(inp=1.0, cw=1.25, cr=0.1, out=5.0)  # price ratios relative to fresh input (assumption, stated in report)
seat = collections.defaultdict(lambda: collections.Counter())
tool_res = collections.defaultdict(lambda: collections.Counter())   # tool -> calls, chars, carry (chars x later calls)
tool_in = collections.defaultdict(lambda: collections.Counter())
out_kind = collections.Counter()
start_ctx = collections.defaultdict(list); max_ctx = collections.defaultdict(list); calls_per = collections.defaultdict(list)
rebuild = collections.defaultdict(lambda: collections.Counter())
result_cost = collections.Counter(); model_usage = collections.defaultdict(lambda: collections.Counter())
gap_hist = collections.defaultdict(lambda: collections.Counter())
files = [f for f in glob.glob(os.path.join(root, '*.jsonl')) if os.path.getmtime(f) > cut]
nfiles = 0
for f in files:
    s = os.path.basename(f).split(':')[0]
    msgs = {}            # message id -> usage (dedupe)
    order = []           # message ids in order
    pending = {}         # tool_use id -> (tool, call index)
    results = []         # (tool, chars, call index)
    last_ts = None
    claude = False
    try:
        for line in open(f, errors='replace'):
            if '"usage"' not in line and 'tool_result' not in line and '"type":"result"' not in line: continue
            try: ev = json.loads(line)
            except Exception: continue
            t = ev.get('type')
            if t == 'result':
                claude = True
                result_cost[s] += ev.get('total_cost_usd') or 0
                for m, u in (ev.get('modelUsage') or {}).items():
                    model_usage[m]['usd'] += u.get('costUSD') or 0
                    model_usage[m]['in'] += u.get('inputTokens') or 0
                    model_usage[m]['out'] += u.get('outputTokens') or 0
                    model_usage[m]['cr'] += u.get('cacheReadInputTokens') or 0
                    model_usage[m]['cw'] += u.get('cacheCreationInputTokens') or 0
                continue
            msg = ev.get('message') or {}
            content = msg.get('content')
            if t == 'assistant' and msg.get('id') and isinstance(msg.get('usage'), dict):
                claude = True
                mid = msg['id']; u = msg['usage']
                if mid not in msgs: order.append(mid)
                prev = msgs.get(mid, {})
                msgs[mid] = dict(inp=u.get('input_tokens', 0), cw=u.get('cache_creation_input_tokens', 0),
                                 cr=u.get('cache_read_input_tokens', 0), out=max(u.get('output_tokens', 0), prev.get('out', 0)))
                if isinstance(content, list):
                    for c in content:
                        if not isinstance(c, dict): continue
                        if c.get('type') == 'tool_use':
                            name = c.get('name', '?'); pending[c.get('id')] = (name, len(order))
                            n = len(json.dumps(c.get('input', {}))); tool_in[name]['calls'] += 1; tool_in[name]['chars'] += n; out_kind['tool input'] += n
                        elif c.get('type') == 'text': out_kind['text'] += len(c.get('text', ''))
                        elif c.get('type') == 'thinking': out_kind['thinking (visible chars)'] += len(c.get('thinking', ''))
            elif t == 'user' and isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get('type') == 'tool_result' and c.get('tool_use_id') in pending:
                        name, idx = pending.pop(c['tool_use_id'])
                        body = c.get('content')
                        size = len(body) if isinstance(body, str) else sum(len(x.get('text', '')) for x in (body or []) if isinstance(x, dict))
                        results.append((name, size, idx))
    except Exception as e:
        print('skip', os.path.basename(f), e); continue
    if not claude or not order: continue
    nfiles += 1
    n = len(order); calls_per[s].append(n)
    ctxs = []
    prev_ctx = 0
    for i, mid in enumerate(order):
        u = msgs[mid]
        for k in ('inp', 'cw', 'cr', 'out'): seat[s][k] += u[k]
        seat[s]['calls'] += 1
        ctx = u['inp'] + u['cw'] + u['cr']; ctxs.append(ctx)
        # a rebuild: most of the context written again instead of read from cache
        if i > 0 and u['cw'] > 20000 and u['cr'] < 0.5 * prev_ctx:
            rebuild[s]['events'] += 1; rebuild[s]['tokens'] += u['cw']
        prev_ctx = ctx
    start_ctx[s].append(ctxs[0]); max_ctx[s].append(max(ctxs))
    for name, size, idx in results:
        tool_res[name]['calls'] += 1; tool_res[name]['chars'] += size; tool_res[name]['carry'] += size * max(0, n - idx)
print(f'transcripts read: {nfiles} of {len(files)} in the last {days:g} days')
tot = collections.Counter()
for s in seat:
    for k in ('inp', 'cw', 'cr', 'out'): tot[k] += seat[s][k]
def eq(c): return sum(c[k] * W[k] for k in W)
T = eq(tot)
print('\n== by seat (tokens in millions; share = share of price-weighted tokens)')
print(f"{'seat':10}{'runs':>5}{'calls':>7}{'fresh in':>9}{'cache wr':>9}{'cache rd':>9}{'output':>8}{'share':>7}{'start ctx':>10}{'peak ctx':>9}{'calls/run':>10}{'rebuilds':>9}{'rebuilt M':>10}")
for s, c in sorted(seat.items(), key=lambda kv: -eq(kv[1])):
    print(f"{s:10}{len(calls_per[s]):>5}{c['calls']:>7}{c['inp']/1e6:>9.2f}{c['cw']/1e6:>9.1f}{c['cr']/1e6:>9.0f}{c['out']/1e6:>8.2f}{eq(c)/T:>7.0%}"
          f"{statistics.median(start_ctx[s])/1e3:>9.0f}k{statistics.median(max_ctx[s])/1e3:>8.0f}k{statistics.median(calls_per[s]):>10.0f}{rebuild[s]['events']:>9}{rebuild[s]['tokens']/1e6:>10.1f}")
print(f"{'ALL':10}{nfiles:>5}{sum(c['calls'] for c in seat.values()):>7}{tot['inp']/1e6:>9.2f}{tot['cw']/1e6:>9.1f}{tot['cr']/1e6:>9.0f}{tot['out']/1e6:>8.2f}")
print('\n== where the price-weighted tokens go (ratios: cache write 1.25, cache read 0.1, output 5, fresh input 1)')
for k, label in (('cr', 'cache re-reads'), ('cw', 'cache writes'), ('out', 'output'), ('inp', 'fresh input')):
    print(f"  {label:16}{tot[k]*W[k]/T:>6.0%}")
print('\n== CLI result events: cost by seat'); 
for s, v in result_cost.most_common(): print(f"  {s:10}${v:>9.0f}")
print('== CLI result events: by model')
for m, u in sorted(model_usage.items(), key=lambda kv: -kv[1]['usd']):
    print(f"  {m:28}${u['usd']:>8.0f}  in {u['in']/1e6:.2f}M  out {u['out']/1e6:.2f}M  cache rd {u['cr']/1e6:.0f}M  cache wr {u['cw']/1e6:.1f}M")
print('\n== tool results: size, and carry (size x later calls in the same run, i.e. how often it is re-read)')
print(f"{'tool':34}{'calls':>6}{'chars':>11}{'avg':>8}{'carry tok M':>12}")
for name, c in sorted(tool_res.items(), key=lambda kv: -kv[1]['carry'])[:22]:
    print(f"{name[:33]:34}{c['calls']:>6}{c['chars']:>11}{c['chars']//max(1,c['calls']):>8}{c['carry']/4/1e6:>12.1f}")
tr = sum(c['carry'] for c in tool_res.values())/4
print(f"  all tool results carried: {tr/1e6:.0f}M tokens re-read = {tr/max(1,tot['cr']):.0%} of all cache re-reads")
print('\n== what agents write (chars)')
for k, v in out_kind.most_common(): print(f"  {k:26}{v:>12}")
print('  top tool inputs:', [(n[:28], c['calls'], c['chars']) for n, c in sorted(tool_in.items(), key=lambda kv: -kv[1]['chars'])[:8]])
