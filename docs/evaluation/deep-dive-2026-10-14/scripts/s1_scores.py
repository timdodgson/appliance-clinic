exec(open('load.py').read())
import statistics as st, collections
dims=list(D['WM-01']['jac']['scores'].keys())
print('== Per-dimension means (primary judge) ==')
print(f"{'dim':24}{'AC':>6}{'GA':>6}{'GA-AC':>7}  #GA>AC #AC>GA")
for k in dims:
    a=[d['jac']['scores'][k] for d in D.values()]; g=[d['jga']['scores'][k] for d in D.values()]
    w=sum(1 for d in D.values() if d['jga']['scores'][k]>d['jac']['scores'][k]); l=sum(1 for d in D.values() if d['jga']['scores'][k]<d['jac']['scores'][k])
    print(f"{k:24}{st.mean(a):6.2f}{st.mean(g):6.2f}{st.mean(g)-st.mean(a):7.2f}  {w:5} {l:5}")
def mean10(s): return st.mean(v for k,v in s.items() if k!='overall')
print('\nmean of 10 non-overall dims: AC %.3f GA %.3f'%(st.mean(mean10(d['jac']['scores']) for d in D.values()),st.mean(mean10(d['jga']['scores']) for d in D.values())))
diff={cid:d['jga']['scores']['overall']-d['jac']['scores']['overall'] for cid,d in D.items()}
sumdiff={cid:sum(d['jga']['scores'].values())-sum(d['jac']['scores'].values()) for cid,d in D.items()}
print('\n== overall diff (ga-ac3) distribution ==',sorted(collections.Counter(diff.values()).items()))
print('sum-of-11-dims diff distribution:',sorted(collections.Counter(sumdiff.values()).items()), 'median',st.median(sumdiff.values()))
print('\nAC overall dist',sorted(collections.Counter(d['jac']['scores']['overall'] for d in D.values()).items()),'GA',sorted(collections.Counter(d['jga']['scores']['overall'] for d in D.values()).items()))
print('\n== worst cases by overall diff then sumdiff ==')
for cid in sorted(D,key=lambda c:(-diff[c],-sumdiff[c]))[:25]:
    d=D[cid]; print(cid, 'ovr ac',d['jac']['scores']['overall'],'ga',d['jga']['scores']['overall'],'sumdiff',sumdiff[cid],'pw',d['pw']['winner'],d['pw']['margin'],'| acEnd',d['ac']['endReason'],'gaEnd',d['ga']['endReason'],'|',d['case']['title'][:55])
def grp(keyf,label):
    g=collections.defaultdict(list)
    for cid,d in D.items():
        for k in keyf(d): g[k].append(cid)
    print(f'\n== by {label} ==')
    print(f"{'group':26}{'n':>3}{'AC':>6}{'GA':>6}{'gap':>6}{'sumgap':>7} pwGA%  totOvrGap")
    for k,ids in sorted(g.items(),key=lambda kv:-st.mean(diff[c] for c in kv[1])):
        a=st.mean(D[c]['jac']['scores']['overall'] for c in ids); gg=st.mean(D[c]['jga']['scores']['overall'] for c in ids)
        print(f"{k:26}{len(ids):3}{a:6.2f}{gg:6.2f}{gg-a:6.2f}{st.mean(sumdiff[c] for c in ids):7.2f} {100*sum(D[c]['pw']['winner']=='ga' for c in ids)/len(ids):4.0f}%  {sum(diff[c] for c in ids):4}")
grp(lambda d:[d['case']['family']],'family')
grp(lambda d:d['case']['tags'],'tag')
grp(lambda d:[d['case']['difficulty']],'difficulty')
def otype(d):
    t=d['case']['tags']; e=d['case']['expected']
    if 'out-of-scope' in t: return ['out-of-scope']
    if 'normal-behaviour' in t: return ['normal-behaviour']
    if 'needs-engineer' in t: return ['needs-engineer']
    if 'replaceable-part' in t: return ['replaceable-part(owner)']
    return ['owner-resolvable(no part)']
grp(otype,'ground-truth outcome type (precedence oos>normal>engineer>part>owner)')
grp(lambda d:[str(d['case']['expected'].get('partRecommendation')).split(':')[0].split(' ')[0]],'expected.partRecommendation (prefix)')
grp(lambda d:['criticalSafetyStop='+str(d['case']['expected'].get('criticalSafetyStop'))],'criticalSafetyStop')
