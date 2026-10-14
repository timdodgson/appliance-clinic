import json,glob,os,random,statistics as st,math
R='/home/user/appliance-clinic/evaluation/rebuild/out'
runs=['21.11','21.15','21.16']
S={}
for r in runs:
    d={}
    for f in glob.glob(f'{R}/independent-100-{r}/judge/primary/*.ac3.json'):
        j=json.load(open(f)); d[j['case']]=j['scores']['overall']
    S[r]=d
common=sorted(set.intersection(*[set(d) for d in S.values()]))
print('n per run',{r:len(d) for r,d in S.items()},'common',len(common))
random.seed(1)
def boot(xs,B=20000):
    n=len(xs); ms=sorted(sum(random.choice(xs) for _ in range(n))/n for _ in range(B))
    return ms[int(.025*B)],ms[int(.975*B)]
for r,d in S.items():
    xs=list(d.values()); print(r,'mean %.3f sd %.3f'%(st.mean(xs),st.pstdev(xs)),'boot95 %.2f-%.2f'%boot(xs),'dist',{k:xs.count(k) for k in range(5)})
sds=[st.pstdev([S[r][c] for r in runs]) for c in common]
ranges=[max(S[r][c] for r in runs)-min(S[r][c] for r in runs) for c in common]
print('mean per-case pop sd %.3f, mean sample sd %.3f'%(st.mean(sds),st.mean([st.stdev([S[r][c] for r in runs]) for c in common])))
print('cases identical across all 3:',ranges.count(0),'range1:',ranges.count(1),'range2:',ranges.count(2),'range>=3:',sum(x>=3 for x in ranges))
for a,b in [('21.11','21.15'),('21.11','21.16'),('21.15','21.16')]:
    diffs=[S[b][c]-S[a][c] for c in common]
    ch=sum(x!=0 for x in diffs)
    print(f'{a}->{b}: changed {ch}/{len(common)}, up {sum(x>0 for x in diffs)} down {sum(x<0 for x in diffs)}, |d|>=2: {sum(abs(x)>=2 for x in diffs)}, mean diff {st.mean(diffs):+.3f}, sd of paired diff {st.stdev(diffs):.3f}')
# within-case (run) variance vs between-case
allx=[S[r][c] for r in runs for c in common]
wv=st.mean([st.variance([S[r][c] for r in runs]) for c in common])
tv=st.variance(allx)
print('within-case variance %.3f, total variance %.3f, share noise %.2f'%(wv,tv,wv/tv))
# MDE: run-mean SD across replicates if case set fixed: sqrt(wv/n)
n=len(common)
se_rerun=math.sqrt(wv/n)
print('SE of run mean from rerun noise alone (same cases) %.3f -> 2-run difference SE %.3f, 95%% threshold %.3f'%(se_rerun,se_rerun*math.sqrt(2),1.96*se_rerun*math.sqrt(2)))
# Paired-diff based MDE (comparing two versions on same 100 cases): sd of paired diff observed between same-version reruns
pdsd=st.mean([st.stdev([S[b][c]-S[a][c] for c in common]) for a,b in [('21.11','21.15'),('21.11','21.16'),('21.15','21.16')]])
print('avg sd of paired per-case diff %.3f -> SE of mean diff %.3f; 95%% (1.96 SE) %.3f; 80%% power MDE (2.8 SE) %.3f'%(pdsd,pdsd/math.sqrt(n),1.96*pdsd/math.sqrt(n),2.8*pdsd/math.sqrt(n)))
# Unpaired (bootstrap CI half-width)
sd=st.mean([st.stdev(list(d.values())) for d in S.values()])
print('between-case sd %.3f -> unpaired SE of diff %.3f, 95%% %.3f'%(sd,sd*math.sqrt(2/n),1.96*sd*math.sqrt(2/n)))
m3={c:st.mean([S[r][c] for r in runs]) for c in common}
print('mean of 3-run average %.3f'%st.mean(m3.values()))
print('most volatile cases:',sorted([(max(S[r][c] for r in runs)-min(S[r][c] for r in runs),c,[S[r][c] for r in runs]) for c in common],reverse=True)[:15])
# outcome flips
O={r:{json.load(open(f))['case']:json.load(open(f)).get('outcome') for f in glob.glob(f'{R}/independent-100-{r}/judge/primary/*.ac3.json')} for r in runs}
print('outcome identical across 3 runs:',sum(len({O[r][c] for r in runs})==1 for c in common),'/',n)
# endReasons
for r in runs:
    from collections import Counter
    c=Counter(json.load(open(f))['endReason'] for f in glob.glob(f'{R}/independent-100-{r}/conversations/ac3/*.json'))
    print(r,'endReason',dict(c))
