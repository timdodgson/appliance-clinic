import json,glob,collections,statistics as st,re,sys
D=sys.argv[1]
files=sorted(glob.glob(D+'/conversations/ac3/*.json'))
turns=[];gates=collections.Counter();gate_turns=collections.Counter();conv_gate=collections.defaultdict(set)
ends=collections.Counter(); comp=[];prompt=[];reason=[];total=[];regen=0;rejected=0;checked=0;stage=collections.Counter();action=collections.Counter();esc=collections.Counter();status=collections.Counter()
replylen=[];plans=collections.Counter();missing_usage=0;errors=0;knowledge_n=collections.Counter();codes=collections.Counter();outcomes=collections.Counter()
skipped=0
for f in files:
    d=json.load(open(f)); ends[d.get('endReason')]+=1
    for m in d['meta']:
        a=m.get('ac2')
        if not a: errors+=1; continue
        turns.append(a)
        u=a.get('usage')
        if u and u.get('completionTokens') is not None: comp.append(u['completionTokens']); prompt.append(u['promptTokens'])
        else: missing_usage+=1
        t=a.get('timings') or {}
        if 'reasonMs' in t: reason.append(t['reasonMs'])
        if 'totalMs' in t: total.append(t['totalMs'])
        if a.get('regenerated'): regen+=1
        rejected+=len(a.get('claimsRejected') or []); checked+=a.get('claimsChecked') or 0
        seen=set()
        for g in (a.get('safety') or {}).get('gates') or []:
            k=g.get('gate')+(':'+g['rule'] if g.get('rule') else '')
            n=g.get('softened',1) if g.get('gate')=='certainty' else 1
            gates[k]+=1; seen.add(k); conv_gate[k].add(d['id'])
        for k in seen: gate_turns[k]+=1
        tags=a.get('tags') or {}
        stage[tags.get('stage')]+=1
        ra=(tags.get('replyAction') or {}).get('value'); action[ra]+=1
        esc[json.dumps((a.get('escalation') or {}).get('reason'))]+=1
        status[a.get('status')]+=1
        for p in a.get('plan') or []:
            plans[re.split(r'[:(]',p)[0][:60]]+=1
        enr=tags.get('enrichment') or {}
        knowledge_n[len(enr.get('knowledgeIds') or [])]+=1
        for c in enr.get('codes') or []: codes[c.get('status')]+=1
    for tr in d['transcript']:
        if tr['role']=='assistant': replylen.append(len(tr['text']))
def q(x):
    x=sorted(x); n=len(x)
    return dict(n=n,min=x[0],p50=x[n//2],p90=x[int(n*.9)],p99=x[min(n-1,int(n*.99))],max=x[-1],mean=round(sum(x)/n,1))
print('conversations',len(files),'turns with ac2 audit',len(turns),'turns without',errors)
print('endReason',dict(ends))
print('completionTokens',q(comp)); print('promptTokens',q(prompt)); print('missing usage',missing_usage)
print('completion>=1800',sum(1 for c in comp if c>=1800),'>=1500',sum(1 for c in comp if c>=1500),'>=1000',sum(1 for c in comp if c>=1000))
print('reasonMs',q(reason)); print('totalMs',q(total))
print('regenerated turns',regen,'claims checked',checked,'rejected',rejected)
print('GATES (events / turns / conversations):')
for k,v in gates.most_common(): print(f'  {k}: {v} / {gate_turns[k]} / {len(conv_gate[k])}')
print('turns with any gate',sum(1 for a in turns if (a.get("safety") or {}).get("gates")))
print('stage',dict(stage)); print('replyAction',dict(action)); print('escalation reason',dict(esc)); print('status',dict(status))
print('assistant reply chars',q(replylen))
print('knowledge docs per turn',dict(knowledge_n)); print('code statuses',dict(codes))
print('PLAN lines:')
for k,v in plans.most_common(): print(f'  {v}  {k}')
