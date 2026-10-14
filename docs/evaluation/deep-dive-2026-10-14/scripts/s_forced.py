exec(open('load.py').read())
import json
cust=lambda d: [t['text'] for t in d['ac']['transcript'] if t['role']=='customer']
rows=[]
for cid,d in D.items():
    cs=cust(d)
    for i,m in enumerate(d['ac']['meta']):
        a=m.get('ac2') or {}
        e=a.get('escalation')
        if e and e.get('forced'):
            hz=(a.get('safety') or {}).get('hazards')
            lab=((a.get('tags') or {}).get('labels') or {}).get('hazard')
            ct=cs[i] if i<len(cs) else ''
            rows.append((cid,i+1,e['reason'],json.dumps(hz)[:80],json.dumps(lab),ct[:160].replace('\n',' '),d['jac']['scores']['overall'],d['jga']['scores']['overall'],d['case']['expected'].get('criticalSafetyStop')))
for r in rows: print(r)
print(len(rows), 'turns;', len(set(r[0] for r in rows)),'cases')
