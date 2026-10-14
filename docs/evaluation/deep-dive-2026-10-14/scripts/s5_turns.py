exec(open('load.py').read())
import statistics as st, collections
J={'ac':'jac','ga':'jga'}
for s in ('ac','ga'):
    t=[D[c][s]['customerTurns'] for c in D]
    print(f"\n== {s.upper()} == customer turns: median {st.median(t)}, mean {st.mean(t):.2f}, dist {sorted(collections.Counter(t).items())}")
    print(' endReason:',dict(collections.Counter(D[c][s]['endReason'] for c in D)))
    print(' judge outcome:',dict(collections.Counter(D[c][J[s]]['outcome'] for c in D)))
    for o in ('resolved','useful-safe-escalation','partial'):
        ids=[c for c in D if D[c][J[s]]['outcome']==o]
        if ids: print(f"  turns when outcome={o}: median {st.median(D[c][s]['customerTurns'] for c in ids)}, mean {st.mean(D[c][s]['customerTurns'] for c in ids):.2f} (n={len(ids)})")
    print(' mean overall by endReason:',{k:round(st.mean(D[c][J[s]]['scores']['overall'] for c in D if D[c][s]['endReason']==k),2) for k in set(D[c][s]['endReason'] for c in D)})
both=[c for c in D if D[c]['jac']['outcome']=='resolved' and D[c]['jga']['outcome']=='resolved']
print('\nboth resolved (n=%d): AC turns median %s mean %.2f | GA median %s mean %.2f'%(len(both),st.median(D[c]['ac']['customerTurns'] for c in both),st.mean(D[c]['ac']['customerTurns'] for c in both),st.median(D[c]['ga']['customerTurns'] for c in both),st.mean(D[c]['ga']['customerTurns'] for c in both)))
print('AC more turns than GA: %d, fewer: %d, equal: %d'%(sum(D[c]['ac']['customerTurns']>D[c]['ga']['customerTurns'] for c in D),sum(D[c]['ac']['customerTurns']<D[c]['ga']['customerTurns'] for c in D),sum(D[c]['ac']['customerTurns']==D[c]['ga']['customerTurns'] for c in D)))
print('one-turn conversations: AC',sum(D[c]['ac']['customerTurns']==1 for c in D),'GA',sum(D[c]['ga']['customerTurns']==1 for c in D))
# AC outcome cross-tab vs GA
x=collections.Counter((D[c]['jac']['outcome'],D[c]['jga']['outcome']) for c in D)
print('\nAC outcome x GA outcome:'); [print(' ',k,v) for k,v in x.most_common()]
# AC service failures
sf=[c for c in D if any('service unavailable' in t['text'].lower() for t in D[c]['ac']['transcript'] if t['role']=='assistant')]
print('\nAC conversations with an "AI service unavailable" turn:',sf)
lat=[(m.get('ac2') or {}).get('timings',{}).get('totalMs') for c in D for m in D[c]['ac']['meta']]
lat=[l for l in lat if l]
print('AC per-turn latency ms: median %d p90 %d'%(st.median(lat),sorted(lat)[int(.9*len(lat))]))
