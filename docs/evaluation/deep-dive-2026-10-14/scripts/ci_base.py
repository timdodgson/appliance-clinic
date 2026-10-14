import json,glob,random
E='/home/user/appliance-clinic/evaluation'
random.seed(2)
def ci(xs,B=20000):
    n=len(xs); ms=sorted(sum(random.choice(xs) for _ in range(n))/n for _ in range(B)); return round(sum(xs)/n,3),round(ms[int(.025*B)],2),round(ms[int(.975*B)],2)
for name,pat in [('ga',f'{E}/independent-100/out/judge/primary/*.ga.json'),('journeys',f'{E}/independent-100/out/judge/primary/*.ac.json'),('ac2',f'{E}/rebuild/out/independent-100/judge/primary/*.ac2.json'),('ac3-21.9',f'{E}/rebuild/out/independent-100/judge/primary/*.ac3.json'),('heldout ac2',f'{E}/rebuild/out/heldout-25/judge/primary/*.ac2.json'),('heldout ga',f'{E}/rebuild/out/heldout-25/judge/primary/*.ga.json')]:
    xs=[json.load(open(f))['scores']['overall'] for f in glob.glob(pat)]
    print(name,len(xs),'mean, 95% bootstrap CI',ci(xs))
# paired ac3 runs vs ac2 per case
ac2={json.load(open(f))['case']:json.load(open(f))['scores']['overall'] for f in glob.glob(f'{E}/rebuild/out/independent-100/judge/primary/*.ac2.json')}
for r in ['21.11','21.15','21.16']:
    a={json.load(open(f))['case']:json.load(open(f))['scores']['overall'] for f in glob.glob(f'{E}/rebuild/out/independent-100-{r}/judge/primary/*.ac3.json')}
    d=[a[c]-ac2[c] for c in a if c in ac2]
    print(r,'paired diff vs ac2: mean %+.3f, 95%% CI'%(sum(d)/len(d)),ci(d)[1:])
a9={json.load(open(f))['case']:json.load(open(f))['scores']['overall'] for f in glob.glob(f'{E}/rebuild/out/independent-100/judge/primary/*.ac3.json')}
a11={json.load(open(f))['case']:json.load(open(f))['scores']['overall'] for f in glob.glob(f'{E}/rebuild/out/independent-100-21.11/judge/primary/*.ac3.json')}
d=[a11[c]-a9[c] for c in a11 if c in a9]; print('21.9 -> 21.11 paired diff %+.3f CI'%(sum(d)/len(d)),ci(d)[1:])
