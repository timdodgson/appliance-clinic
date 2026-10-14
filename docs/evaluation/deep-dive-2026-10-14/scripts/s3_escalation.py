exec(open('load.py').read())
import statistics as st, collections
# Manual verdict per AC 'escalated' conversation, from reading hiddenTruth + expected.escalation + the AC transcript ending (esc_dump.txt)
# REQUIRED: ground truth requires a professional/stop-use unconditionally (and AC's route is acceptable)
# COND_MET: ground truth escalation is conditional and the condition was met in the conversation (e.g. customer cannot access/test)
# WRONG_ROUTE: a professional/safety hand-off was needed but AC sent them to the wrong party (recall line, Gas Safe vs 999, local repairer)
# PREMATURE: GT engineer is conditional on a cheap owner step/test that AC skipped (fuse, re-test, family member, measurement)
# UNNECESSARY: GT says owner fix / DIY part / no professional needed
V={'WM-03':'UNNECESSARY','WM-06':'COND_MET','WM-08':'REQUIRED','WM-09':'PREMATURE','WM-12':'UNNECESSARY',
'WD-01':'REQUIRED','WD-07':'REQUIRED','TD-01':'WRONG_ROUTE','TD-02':'REQUIRED','TD-06':'COND_MET','TD-09':'PREMATURE',
'DW-03':'UNNECESSARY','DW-04':'REQUIRED','DW-08':'COND_MET','DW-09':'REQUIRED','DW-10':'PREMATURE','FF-01':'COND_MET',
'FF-05':'WRONG_ROUTE','FF-06':'REQUIRED','FF-10':'REQUIRED','MW-01':'UNNECESSARY','MW-02':'REQUIRED','MW-03':'REQUIRED',
'MW-06':'REQUIRED','MW-08':'REQUIRED','MW-09':'REQUIRED','OC-03':'REQUIRED','OC-05':'WRONG_ROUTE','OC-06':'REQUIRED',
'OC-07':'REQUIRED','OC-09':'UNNECESSARY','OC-10':'PREMATURE','HB-03':'REQUIRED','HB-05':'REQUIRED','HB-07':'REQUIRED',
'HB-08':'REQUIRED','HB-09':'COND_MET','VC-05':'REQUIRED','VC-07':'UNNECESSARY','VC-08':'REQUIRED','VC-09':'WRONG_ROUTE','OS-02':'UNNECESSARY'}
esc=[c for c,d in D.items() if d['ac']['endReason']=='escalated']
assert set(esc)==set(V), set(esc)^set(V)
ov=lambda c,k:D[c][k]['scores']['overall']; es=lambda c,k:D[c][k]['scores']['escalation']
print('AC escalated:',len(esc))
print(f"{'verdict':12}{'n':>3}{'AC ovr':>8}{'GA ovr':>8}{'gap':>6}{'sumGap':>7}{'ACesc':>7}{'GAesc':>7}  GA ended escalated  cases")
for v in ['REQUIRED','COND_MET','WRONG_ROUTE','PREMATURE','UNNECESSARY']:
    ids=[c for c in esc if V[c]==v]
    print(f"{v:12}{len(ids):3}{st.mean(ov(c,'jac') for c in ids):8.2f}{st.mean(ov(c,'jga') for c in ids):8.2f}{sum(ov(c,'jga')-ov(c,'jac') for c in ids):6}{st.mean(sum(D[c]['jga']['scores'].values())-sum(D[c]['jac']['scores'].values()) for c in ids):7.1f}{st.mean(es(c,'jac') for c in ids):7.2f}{st.mean(es(c,'jga') for c in ids):7.2f}  {sum(D[c]['ga']['endReason']=='escalated' for c in ids):2}/{len(ids)}  {' '.join(ids)}")
bad=[c for c in esc if V[c] in ('PREMATURE','UNNECESSARY')]
print('\nunjustified (PREMATURE+UNNECESSARY): %d of %d; overall gap sum %d; mean AC %.2f vs GA %.2f'%(len(bad),len(esc),sum(ov(c,'jga')-ov(c,'jac') for c in bad),st.mean(ov(c,'jac') for c in bad),st.mean(ov(c,'jga') for c in bad)))
print('GA outcomes on those:',collections.Counter(D[c]['jga']['outcome'] for c in bad), 'GA endReason:',collections.Counter(D[c]['ga']['endReason'] for c in bad))
# Inverse view: needs-engineer tagged cases where AC did not escalate
ne=[c for c,d in D.items() if 'needs-engineer' in d['case']['tags']]
print('\nneeds-engineer tagged: %d; AC escalated %d, GA escalated %d'%(len(ne),sum(D[c]['ac']['endReason']=='escalated' for c in ne),sum(D[c]['ga']['endReason']=='escalated' for c in ne)))
print('needs-engineer but AC not escalated:',[(c,D[c]['ac']['endReason'],ov(c,'jac'),ov(c,'jga')) for c in ne if D[c]['ac']['endReason']!='escalated'])
# GA concluded but judge outcome useful-safe-escalation (GA escalates inside a concluded conversation)
print('\nJudge outcome useful-safe-escalation: AC',sum(D[c]['jac']['outcome']=='useful-safe-escalation' for c in D),'GA',sum(D[c]['jga']['outcome']=='useful-safe-escalation' for c in D))
print('Escalation dim mean among AC-escalated: AC %.2f GA %.2f'%(st.mean(es(c,'jac') for c in esc),st.mean(es(c,'jga') for c in esc)))
non=[c for c in D if c not in esc]
print('Escalation dim mean among AC-not-escalated: AC %.2f GA %.2f'%(st.mean(es(c,'jac') for c in non),st.mean(es(c,'jga') for c in non)))
# forced vs reply escalations
import json
f=collections.Counter()
for c in esc:
    r=[ (m.get('ac2') or {}).get('escalation') for m in D[c]['ac']['meta']]
    r=[x for x in r if x]
    f['forced' if any(x.get('forced') for x in r) else ('reply' if r else 'none-in-meta')]+=1
    V2=V[c]
print('AC escalation trigger (any turn):',f)
for v in ['UNNECESSARY','PREMATURE']:
    for c in esc:
        if V[c]!=v: continue
        r=[(m.get('ac2') or {}).get('escalation') for m in D[c]['ac']['meta']]
        print(' ',v,c,[ (x['reason'] if x else None) for x in r])
