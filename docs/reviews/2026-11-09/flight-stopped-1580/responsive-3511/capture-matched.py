from pathlib import Path
import subprocess,os,json,hashlib,datetime
base=Path('/private/tmp/mc-review-fix-1580');css=base/'apps/web/src/needs/needs.css';test=base/'apps/web/test/FlightStopped.browser.test.ts';finalcss=css.read_bytes();finaltest=test.read_bytes();baseline=subprocess.check_output(['git','show','d044ea9c665ab7f629b3229fc61a6d9d382e9330:apps/web/src/needs/needs.css'],cwd=base)
soft=finaltest.decode().replace('expect(\n                  box.y + box.h,','expect.soft(\n                  box.y + box.h,')
if 'expect.soft' not in soft:raise SystemExit('No bounded soft assertion matched; leave source unchanged')
receipts=[]
try:
 css.write_bytes(baseline);test.write_text(soft)
 for phase in ['before']:
  out='/tmp/mc-1580-responsive-'+phase+'-matched';env={**os.environ,'MC_SHOT_DIR':out}
  with open('/tmp/mc-1580-responsive-'+phase+'-matched.log','w') as log:r=subprocess.run(['pnpm','-s','vitest','apps/web/test/FlightStopped.browser.test.ts','--run'],cwd=base,env=env,stdout=log,stderr=subprocess.STDOUT)
  receipts.append({'phase':phase,'exit':r.returncode,'cssSha256':hashlib.sha256(baseline).hexdigest(),'shots':out,'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':'d044ea9c exact committed needs.css; production web otherwise identical','assertions':'All geometry assertions retained; pane-bottom assertions soft to collect every failing baseline viewport/theme before exit1'})
finally:
 css.write_bytes(finalcss);test.write_bytes(finaltest)
out='/tmp/mc-1580-responsive-after-matched'
with open('/tmp/mc-1580-responsive-after-matched.log','w') as log:r=subprocess.run(['pnpm','-s','vitest','apps/web/test/FlightStopped.browser.test.ts','--run'],cwd=base,env={**os.environ,'MC_SHOT_DIR':out},stdout=log,stderr=subprocess.STDOUT)
receipts.append({'phase':'after','exit':r.returncode,'cssSha256':hashlib.sha256(finalcss).hexdigest(),'shots':out,'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':'current uncommitted scoped responsive rework; exact source hash retained','assertions':'Canonical regression with hard geometry assertions'})
Path('/tmp/mc-1580-responsive-matched-receipt.json').write_text(json.dumps(receipts,indent=2));print(json.dumps(receipts))
