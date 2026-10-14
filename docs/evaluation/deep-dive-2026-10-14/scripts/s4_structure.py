exec(open('load.py').read())
import re, statistics as st, collections
IMP=set('check look try make ensure inspect turn remove clean press hold listen feel test unplug switch open take run rinse wipe pull empty clear see confirm reset leave unscrew twist lift move fill put set use dry wash run push straighten feel call contact book stop keep note measure place drain'.split())
FILL=set('please first then also next now so and finally carefully gently just secondly thirdly lastly meanwhile'.split())
ASK=re.compile(r"\\b(can|could|would) you (please )?(check|look|see|try|tell|confirm|feel|listen|open|remove|take|turn|run|test|inspect)",re.I)
CAUSE=re.compile(r"\b(because|caused by|this means|which means|that means|usually means|usually because|is designed|by design|the reason|that's why|that is why|this is why|happens when|occurs when|so the|which is why|this explains|that explains|is normal because|this is normal|due to)\b",re.I)
PANEL=re.compile(r"\[[^\]]*\]")
def split_body(t):
    panels=PANEL.findall(t); body=PANEL.sub(' ',t)
    return body,panels
def metrics(t,system):
    body,panels=split_body(t) if system=='ac' else (t,[])
    words=len(re.findall(r"\b\w+\b",body))
    q=body.count('?')
    lines=[l.strip() for l in body.split('\n')]
    listitems=sum(1 for l in lines if re.match(r"^([-*•]|\d+[.)])\s+",l))
    sents=[s.strip(' *#-•\t0123456789.)') for s in re.split(r"(?<=[.!?])\s+|\n+",body) if s.strip()]
    def first(s):
        w=[x for x in re.split(r"[\s,:]+",s.lower()) if x]
        while w and w[0] in FILL: w=w[1:]
        return w[0] if w else ''
    imp=sum(1 for s in sents if s and (first(s) in IMP or ASK.search(s)))
    heads=sum(1 for l in lines if l.startswith('#'))
    return dict(words=words,q=q,list=listitems,imp=imp,checks=max(listitems,imp),cause=bool(CAUSE.search(body)),heads=heads,panels=len(panels),
                stopcard=('Stop using this appliance' in t), partpanel=bool(re.search(r"suitable replacement|Part card|Confirmed fit",t)))
R={'ac':[], 'ga':[]}; C={'ac':{}, 'ga':{}}
for cid,d in D.items():
    for s in ('ac','ga'):
        ms=[metrics(t['text'],s) for t in d[s]['transcript'] if t['role']=='assistant']
        R[s]+= [dict(m,cid=cid,i=i) for i,m in enumerate(ms)]
        C[s][cid]=ms
def med(xs): return st.median(xs) if xs else float('nan')
print('== per reply (heuristic text metrics) ==')
print(f"{'metric':34}{'AC med':>8}{'AC mean':>8}{'GA med':>8}{'GA mean':>8}")
for k,lab in [('words','words (AC body excl. [panels])'),('q','question marks / reply'),('checks','checks offered (max(list items, imperative sents))'),('list','list items'),('heads','markdown headings'),('panels','AC bracket panels')]:
    a=[r[k] for r in R['ac']]; g=[r[k] for r in R['ga']]
    print(f"{lab[:34]:34}{med(a):8.1f}{st.mean(a):8.2f}{med(g):8.1f}{st.mean(g):8.2f}")
for k,lab in [('cause','% replies with causal explanation'),('stopcard','% replies with canned stop card'),('partpanel','% replies with part panel/card')]:
    print(f"{lab:34}{100*st.mean(r[k] for r in R['ac']):8.0f}%{'':8}{100*st.mean(r[k] for r in R['ga']):8.0f}%")
print('replies: AC',len(R['ac']),'GA',len(R['ga']))
print('\nfirst reply only: words AC med %d GA med %d ; checks AC med %.1f GA med %.1f; q AC med %.1f GA med %.1f'%(
  med([C['ac'][c][0]['words'] for c in D]),med([C['ga'][c][0]['words'] for c in D]),
  med([C['ac'][c][0]['checks'] for c in D]),med([C['ga'][c][0]['checks'] for c in D]),
  med([C['ac'][c][0]['q'] for c in D]),med([C['ga'][c][0]['q'] for c in D])))
print('final reply: words AC med %d GA med %d; cause-explained AC %d%% GA %d%%'%(med([C['ac'][c][-1]['words'] for c in D]),med([C['ga'][c][-1]['words'] for c in D]),
  100*st.mean(C['ac'][c][-1]['cause'] for c in D),100*st.mean(C['ga'][c][-1]['cause'] for c in D)))
print('total assistant words per conversation: AC med %d GA med %d'%(med([sum(m['words'] for m in C['ac'][c]) for c in D]),med([sum(m['words'] for m in C['ga'][c]) for c in D])))
# AC replies with >1 question
print('AC replies with 0 q: %d%%, 1 q: %d%%, >=2 q: %d%%'%tuple(100*st.mean(f(r['q']) for r in R['ac']) for f in (lambda x:x==0,lambda x:x==1,lambda x:x>=2)))
print('GA replies with 0 q: %d%%, 1 q: %d%%, >=2 q: %d%%'%tuple(100*st.mean(f(r['q']) for r in R['ga']) for f in (lambda x:x==0,lambda x:x==1,lambda x:x>=2)))
# no-part cases with part panel
np_=[c for c in D if D[c]['case']['expected'].get('noPartNeeded') or D[c]['case']['expected'].get('partRecommendation','').startswith('not-justified')]
print('\nAC conversations with a part panel/card: %d of 100; in no-part/not-justified cases: %d of %d'%(sum(any(m['partpanel'] for m in C['ac'][c]) for c in D),sum(any(m['partpanel'] for m in C['ac'][c]) for c in np_),len(np_)))
print('AC conversations with canned stop card: %d; with the same stop card in >=2 replies: %d'%(sum(any(m['stopcard'] for m in C['ac'][c]) for c in D),sum(sum(m['stopcard'] for m in C['ac'][c])>=2 for c in D)))
# correlation within AC
def rank(xs):
    s=sorted(range(len(xs)),key=lambda i:xs[i]); r=[0]*len(xs); i=0
    while i<len(s):
        j=i
        while j+1<len(s) and xs[s[j+1]]==xs[s[i]]: j+=1
        for k in range(i,j+1): r[s[k]]=(i+j)/2+1
        i=j+1
    return r
def pearson(a,b):
    ma,mb=st.mean(a),st.mean(b); num=sum((x-ma)*(y-mb) for x,y in zip(a,b)); den=(sum((x-ma)**2 for x in a)*sum((y-mb)**2 for y in b))**.5; return num/den
def spear(a,b): return pearson(rank(a),rank(b))
ids=list(D)
for s in ('ac','ga'):
    ov=[D[c]['j'+('ac' if s=='ac' else 'ga')]['scores']['overall'] for c in ids]
    du=[D[c]['j'+('ac' if s=='ac' else 'ga')]['scores']['diagnosticUsefulness'] for c in ids]
    mw=[st.mean(m['words'] for m in C[s][c]) for c in ids]
    fw=[C[s][c][-1]['words'] for c in ids]; tw=[sum(m['words'] for m in C[s][c]) for c in ids]
    ck=[st.mean(m['checks'] for m in C[s][c]) for c in ids]; ca=[st.mean(m['cause'] for m in C[s][c]) for c in ids]
    print(f"\n{s.upper()} Spearman vs overall: meanWords/reply {spear(mw,ov):+.2f}, finalReplyWords {spear(fw,ov):+.2f}, totalWords {spear(tw,ov):+.2f}, meanChecks {spear(ck,ov):+.2f}, causeShare {spear(ca,ov):+.2f}; meanWords vs diagnosticUsefulness {spear(mw,du):+.2f}")
    if s=='ac':
        q=sorted(ids,key=lambda c:st.mean(m['words'] for m in C['ac'][c]))
        for qi in range(4):
            part=q[qi*25:(qi+1)*25]
            print('  AC words/reply quartile %d: words %3.0f-%3.0f  mean overall %.2f  GA-AC gap %.2f  pwGA %d/25'%(qi+1,st.mean(C['ac'][part[0]][0]['words'] for _ in [0]) if False else min(st.mean(m['words'] for m in C['ac'][c]) for c in part),max(st.mean(m['words'] for m in C['ac'][c]) for c in part),
              st.mean(D[c]['jac']['scores']['overall'] for c in part),st.mean(D[c]['jga']['scores']['overall']-D[c]['jac']['scores']['overall'] for c in part),sum(D[c]['pw']['winner']=='ga' for c in part)))
# excluding hazard/out-of-scope (where short canned replies may be correct)
ids2=[c for c in ids if not set(D[c]['case']['tags'])&{'hazard','out-of-scope'}]
ov=[D[c]['jac']['scores']['overall'] for c in ids2]; mw=[st.mean(m['words'] for m in C['ac'][c]) for c in ids2]; fw=[C['ac'][c][-1]['words'] for c in ids2]
print('\nAC excl hazard/out-of-scope (n=%d): Spearman meanWords %+.2f finalWords %+.2f'%(len(ids2),spear(mw,ov),spear(fw,ov)))
# pairwise: does relative length predict winner?
rel=[(st.mean(m['words'] for m in C['ga'][c])/max(1,st.mean(m['words'] for m in C['ac'][c]))) for c in ids]
print('GA/AC words-per-reply ratio: median %.1fx; AC longer than GA in %d cases (AC won %d of them)'%(st.median(rel),sum(r<1 for r in rel),sum(r<1 and D[c]['pw']['winner']=='ac3' for r,c in zip(rel,ids))))
