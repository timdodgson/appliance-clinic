exec(open('load.py').read()); exec(open('codes.py').read())
import statistics as st, collections
ov=lambda d,k:d[k]['scores']['overall']
gap={c:ov(D[c],'jga')-ov(D[c],'jac') for c in D}
sgap={c:sum(D[c]['jga']['scores'].values())-sum(D[c]['jac']['scores'].values()) for c in D}
tot_pos=sum(max(0,g) for g in gap.values())
print('GA-won cases:',len(CODES),' total positive overall gap (all 100 cases):',tot_pos,' net gap:',sum(gap.values()))
print('positive gap inside GA-won cases:',sum(max(0,gap[c]) for c in CODES))
rows=[]
for k in CLASSES:
    ids=[c for c,v in CODES.items() if k in v]; prim=[c for c,v in CODES.items() if v[0]==k]
    if not ids: continue
    up=sum(max(0,gap[c]) for c in ids)                      # upper bound: full gap of every case touched
    split=sum(max(0,gap[c])/len(CODES[c]) for c in ids)     # equal split among the case's classes
    wtd=sum(max(0,gap[c])*((0.5 if CODES[c][0]==k else 0)+ (0.5 if len(CODES[c])==1 else 0.5/(len(CODES[c])-1) if CODES[c][0]!=k else 0) + (0.5 if len(CODES[c])==1 and CODES[c][0]==k else 0)) for c in ids) if False else None
    # primary-weighted: primary class gets 50% + its share, others share remaining 50%
    def w(c):
        v=CODES[c]; n=len(v)
        if n==1: return 1.0
        return 0.5 if v[0]==k else 0.5/(n-1)
    pw=sum(max(0,gap[c])*w(c) for c in ids)
    rows.append((k,len(ids),len(prim),st.mean(gap[c] for c in ids),st.mean(sgap[c] for c in ids),up,split,pw,sum(gap[c]>0 for c in ids)))
rows.sort(key=lambda r:-r[7])
print(f"\n{'class':13}{'n':>4}{'prim':>5}{'meanOvrGap':>11}{'meanSumGap':>11}{'upper':>7}{'eqSplit':>8}{'primWtd':>8}{'#gap>0':>7}")
for r in rows: print(f"{r[0]:13}{r[1]:4}{r[2]:5}{r[3]:11.2f}{r[4]:11.1f}{r[5]:7}{r[6]:8.1f}{r[7]:8.1f}{r[8]:7}")
print('\ncheck: sum eqSplit=%.1f sum primWtd=%.1f (should equal positive gap in GA-won cases)'%(sum(r[6] for r in rows),sum(r[7] for r in rows)))
print('\nclass counts per case: median',st.median(len(v) for v in CODES.values()))
print('\n== per-class case lists ==')
for k in CLASSES:
    ids=[c for c,v in CODES.items() if k in v]
    print(k, ' '.join(f"{c}{'*' if CODES[c][0]==k else ''}({gap[c]:+d})" for c in ids))
# super-groups
SG={'Over-caution (ESC_OVER+SAFETY_NOISE)':['ESC_OVER','SAFETY_NOISE'],
    'Shallow content (THIN+DECLINE_BARE+PART_MISSING)':['THIN','DECLINE_BARE','PART_MISSING'],
    'Diagnostic reasoning (MISSED_CHECK+OVERCONF+KNOWLEDGE+DETOUR+MODEL_CODE)':['MISSED_CHECK','OVERCONF','KNOWLEDGE','DETOUR','MODEL_CODE'],
    'Conversation state (IGNORED_INFO+LOOP)':['IGNORED_INFO','LOOP'],
    'UI/parts noise (PART_PANEL+GARBLED)':['PART_PANEL','GARBLED'],
    'Safety gaps (SAFETY_MISS+ESC_ROUTE)':['SAFETY_MISS','ESC_ROUTE']}
print('\n== super-groups (case counted once if any member class) ==')
for n,ks in SG.items():
    ids=[c for c,v in CODES.items() if set(v)&set(ks)]
    print(f"{n:75} n={len(ids):3} upper={sum(max(0,gap[c]) for c in ids):3} meanGap={st.mean(gap[c] for c in ids):.2f}")
