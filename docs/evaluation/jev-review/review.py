# Print one jev-led conversation for review: customer message, what Jev was offered, what it picked, the reply.
import json,sys
d=json.load(open(sys.argv[1]))
T=d['transcript']; A=[t['text'] for t in T if t['role']=='assistant']; C=[t['text'] for t in T if t['role']=='customer']
print(f"TEST {d['id']}  (ended: {d['endReason']}, {d['customerTurns']} customer messages)\n")
for i,m in enumerate(d['meta']):
  a=m.get('ac2') or {}
  plan=(a.get('plan') or [''])[0]
  ch={}
  if plan.startswith('jev-led: '):
    try: ch=json.loads(plan[len('jev-led: '):])
    except Exception: ch={}
  print(f"--- Turn {i+1}")
  print(f"CUSTOMER: {C[i]}")
  off=ch.get('offered')
  if off:
    print(f"JEV WAS OFFERED - situations ({len(off['situations'])}{', + engineer' if off.get('engineerAllowed') else ''}):")
    for s in off['situations']: print(f"    - {s[:150]}")
    print(f"  next steps ({len(off['next'])}):")
    for s in off['next']: print(f"    - {s[:150]}")
    if off.get('removed'): print(f"  removed before Jev picked (done / refused / pointless): {len(off['removed'])}"); [print(f"    x {r}") for r in off['removed']]
    if 'note' in ch: print(f"  note: {ch.get('note')} | findings settle it: {ch.get('settled')}")
    sit=ch.get('situation'); nx=ch.get('next')
    print(f"JEV PICKED: situation = {sit if isinstance(sit,str) else (sit or {}).get('text')}")
    print(f"            next      = {(nx or {}).get('text','-')[:200]}")
  else:
    print(f"(no Jev choice this turn: {ch.get('state') or 'handled by fixed code/safety'})")
  print(f"REPLY: {A[i]}\n")
