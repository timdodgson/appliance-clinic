import json,glob,statistics as st
from collections import Counter,defaultdict
E='/home/user/appliance-clinic/evaluation'
C={k['id']:k for k in json.load(open(f'{E}/independent-100/cases.json'))['cases']}
notneeded=lambda c: C[c]['expected']['escalation'].lower().startswith('not needed')
def load(convdir,judgedir,sys):
    out={}
    for f in glob.glob(f'{convdir}/*.json'):
        c=json.load(open(f)); jid=f"{judgedir}/{c['id']}.{sys}.json"
        try: j=json.load(open(jid))
        except: j=None
        out[c['id']]=dict(end=c['endReason'],turns=c['customerTurns'],ov=j and j['scores']['overall'],outc=j and j.get('outcome'))
    return out
sets={'ga':load(f'{E}/independent-100/out/conversations/ga',f'{E}/rebuild/out/independent-100/judge/primary','ga'),
      'ac2':load(f'{E}/rebuild/out/independent-100/conversations/ac2',f'{E}/rebuild/out/independent-100/judge/primary','ac2')}
# GA judge location may differ
import os
print('ga judge files rebuild/out/independent-100:',len(glob.glob(f'{E}/rebuild/out/independent-100/judge/primary/*.ga.json')),'independent-100/out/judge/primary:',len(glob.glob(f'{E}/independent-100/out/judge/primary/*ga*.json')))
print(os.listdir(f'{E}/independent-100/out/judge/primary')[:4])
sets['ga']=load(f'{E}/independent-100/out/conversations/ga',f'{E}/independent-100/out/judge/primary','ga')
for r in ['21.11','21.15','21.16']:
    sets['ac3-'+r]=load(f'{E}/rebuild/out/independent-100-{r}/conversations/ac3',f'{E}/rebuild/out/independent-100-{r}/judge/primary','ac3')
print('expected escalation "not needed...":',sum(notneeded(c) for c in C),'/100')
for s,d in sets.items():
    ends=Counter(v['end'] for v in d.values())
    byend={e:round(st.mean([v['ov'] for v in d.values() if v['end']==e and v['ov'] is not None]),2) for e in ends if any(v['end']==e and v['ov'] is not None for v in d.values())}
    esc_nn=[c for c,v in d.items() if v['end']=='escalated' and notneeded(c)]
    esc1=[c for c,v in d.items() if v['end']=='escalated' and v['turns']==1]
    print(f"{s}: ends {dict(ends)} meanOverallByEnd {byend} | escalated-end where expected 'not needed': {len(esc_nn)} (mean ov {st.mean([d[c]['ov'] for c in esc_nn]) if esc_nn else 0:.2f}) | escalated after 1 customer msg: {len(esc1)}")
# For not-needed cases: AC3 escalated vs GA
for r in ['21.11','21.15','21.16']:
    a=sets['ac3-'+r]; g=sets['ga']
    xs=[c for c in a if a[c]['end']=='escalated' and notneeded(c)]
    print(r,'premature-escalation cases:',xs, 'ac3 ov',[a[c]['ov'] for c in xs],'ga end/ov',[(g[c]['end'],g[c]['ov']) for c in xs])
# overall: AC3 vs GA gap split by AC3 end reason (3-run pooled)
gap=defaultdict(list)
for r in ['21.11','21.15','21.16']:
    a=sets['ac3-'+r]
    for c,v in a.items():
        if v['ov'] is None: continue
        gap[v['end']].append(sets['ga'][c]['ov']-v['ov'])
print('GA-AC3 gap by AC3 endReason (pooled 3 runs): ',{e:(len(x),round(st.mean(x),2),round(sum(x)/300,3)) for e,x in gap.items()}, '(n, mean gap, contribution to total gap per run)')
print('--- AC3 escalated-ending cases, pooled 3 runs')
X=[(r,c,v) for r in ['21.11','21.15','21.16'] for c,v in sets['ac3-'+r].items() if v['end']=='escalated']
print('n',len(X),'mean customer turns at escalation %.2f'%st.mean(v['turns'] for _,_,v in X))
print('AC3 outcome:',Counter(v['outc'] for _,_,v in X))
print('GA outcome on same cases:',Counter(sets['ga'][c]['outc'] for _,c,_ in X),'GA end:',Counter(sets['ga'][c]['end'] for _,c,_ in X))
both=[(r,c) for r,c,v in X if sets['ga'][c]['outc']=='resolved' and v['outc']!='resolved']
print('AC3 escalated & not resolved while GA resolved:',len(both),'of',len(X),'-> ~%.1f per run'%(len(both)/3))
cs=Counter(c for _,c in both); print('cases:',sorted(cs.items(),key=lambda x:-x[1]))
print('criticalSafetyStop among those:',sum(C[c]['expected'].get('criticalSafetyStop') for c in cs))
print('--- escalated endings by criticalSafetyStop')
crit=lambda c: bool(C[c]['expected'].get('criticalSafetyStop'))
print('cases with criticalSafetyStop:',sum(crit(c) for c in C))
for s,d in sets.items():
    e=[c for c,v in d.items() if v['end']=='escalated']
    print(s,'escalated',len(e),'in critical-stop cases',sum(crit(c) for c in e),'in non-critical cases',sum(not crit(c) for c in e), 'turn-limit endings',sum(v['end']=='turn-limit' for v in d.values()))
