# Print one jev-led conversation for review, step by step for every turn:
#   1 what the LLM understood, 2 Jev's labels, 3 the notes found, 4 the note Jev picked, every step's verdict
#   (done / refused / pointless, kept or removed), the options, Jev's picks, the LLM's answer to a direct question,
#   and the reply.
import json, sys

d = json.load(open(sys.argv[1]))
T = d['transcript']
A = [t['text'] for t in T if t['role'] == 'assistant']
C = [t['text'] for t in T if t['role'] == 'customer']
print(f"TEST {d['id']}  (ended: {d['endReason']}, {d['customerTurns']} customer messages)\n")
for i, m in enumerate(d['meta']):
    a = m.get('ac2') or {}
    plan = a.get('plan') or []
    ch, tr = {}, {}
    for p in plan:
        if p.startswith('jev-led: '):
            try: ch = json.loads(p[len('jev-led: '):])
            except Exception: pass
        if p.startswith('trace: '):
            try: tr = json.loads(p[len('trace: '):])
            except Exception: pass
    print(f"--- Turn {i+1}")
    print(f"CUSTOMER: {C[i]}")
    if tr:
        u = tr.get('understood') or {}
        print(f"1 LLM UNDERSTOOD: appliance={u.get('appliance')} brand={u.get('brand')} model={u.get('model')} codes={u.get('codes')} symptom={u.get('symptom')!r} question={u.get('customerQuestion')!r}")
        print(f"   checks reported: {u.get('checksReported')}  facts: {u.get('facts')}")
        lab = tr.get('labels') or {}
        print("2 JEV LABELS: " + "; ".join(f"{k}={v}" for k, v in lab.items() if v not in (None, 'null (null)', 'null (None)', '[]')))
        print(f"3 NOTES FOUND: {tr.get('notes')}  normal: {tr.get('normal')}  codes: {tr.get('codes')}  stage: {tr.get('stage')}")
    off = ch.get('offered')
    if off:
        print(f"4 JEV: note picked = {ch.get('note')} | findings settle it = {ch.get('settled')} | engineer allowed = {off.get('engineerAllowed')}")
        print(f"  situations offered ({len(off['situations'])}):")
        for s in off['situations']: print(f"    - {s[:150]}")
        if off.get('verdicts'):
            print("  every step, Jev's verdict (done / refused / pointless) -> kept or removed:")
            for v in off['verdicts']:
                print(f"    {'KEPT   ' if v['kept'] else 'REMOVED'} d={v['done']} r={v['refused']} p={v['pointless']}  {v['step']}")
        sit = ch.get('situation'); nx = ch.get('next')
        print(f"  JEV PICKED: situation = {sit if isinstance(sit, str) else (sit or {}).get('text')}")
        print(f"              next      = {(nx or {}).get('text', '-')[:220]}")
    else:
        print(f"4 (no Jev choice this turn: {ch.get('state') or 'fixed code / safety'})")
    if ch.get('answer'): print(f"LLM ANSWER TO THEIR QUESTION: {ch['answer']}")
    print(f"REPLY: {A[i]}\n")
