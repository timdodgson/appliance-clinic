exec(open('load.py').read())
import statistics as st
cases=set(); sticky=0; tot=0; noncrit=set()
for c,d in D.items():
    for m in d['ac']['meta']:
        a=m.get('ac2') or {}; e=a.get('escalation')
        if e and e.get('forced'):
            tot+=1; cases.add(c)
            lab=(((a.get('tags') or {}).get('labels') or {}).get('hazard') or {}).get('value')
            if lab is None: sticky+=1
            if not d['case']['expected'].get('criticalSafetyStop'): noncrit.add(c)
ov=lambda c,k:D[c][k]['scores']['overall']
print('forced-escalation turns',tot,'in',len(cases),'cases; turns where this turn\'s hazard label was null (carried over from earlier turn):',sticky)
for name,ids in (('forced, GT criticalSafetyStop=True',sorted(cases-noncrit)),('forced, GT criticalSafetyStop=False',sorted(noncrit))):
    print(f"{name}: n={len(ids)} AC {st.mean(ov(c,'jac') for c in ids):.2f} GA {st.mean(ov(c,'jga') for c in ids):.2f} gapSum {sum(ov(c,'jga')-ov(c,'jac') for c in ids)}  {ids}")
crit=[c for c in D if D[c]['case']['expected'].get('criticalSafetyStop')]
print('GT criticalSafetyStop cases:',len(crit),'of which AC forced a stop card:',len(set(crit)&cases),'; not forced:',sorted(set(crit)-cases))
