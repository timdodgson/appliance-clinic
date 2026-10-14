exec(open('load.py').read())
import statistics as st, collections
ov=lambda c,k:D[c][k]['scores']['overall']
g=collections.defaultdict(list)
for c in D: g[(D[c]['jac']['outcome'],D[c]['jga']['outcome'])].append(c)
print('Overall gap by (AC outcome, GA outcome):')
for k,ids in sorted(g.items(),key=lambda kv:-len(kv[1])):
    print(f"  {str(k):55} n={len(ids):2} AC {st.mean(ov(c,'jac') for c in ids):.2f} GA {st.mean(ov(c,'jga') for c in ids):.2f} gapSum {sum(ov(c,'jga')-ov(c,'jac') for c in ids):3}")
# second judge consistency
s2=[c for c in D if D[c]['jac2']]
print('\nsecond judge on AC: n=%d  primary mean %.2f  second mean %.2f  exact agree %d  within1 %d'%(len(s2),st.mean(ov(c,'jac') for c in s2),st.mean(D[c]['jac2']['scores']['overall'] for c in s2),sum(ov(c,'jac')==D[c]['jac2']['scores']['overall'] for c in s2),sum(abs(ov(c,'jac')-D[c]['jac2']['scores']['overall'])<=1 for c in s2)))
# critical flags
for k,sys in (('jac','AC'),('jga','GA')):
    cnt=collections.Counter(f for c in D for f,v in D[c][k]['critical'].items() if v['flag'])
    print(sys,'critical flags:',dict(cnt),' cases with any:',sum(any(v['flag'] for v in D[c][k]['critical'].values()) for c in D))
print('looped flag AC',sum(D[c]['jac']['looped'] for c in D),'GA',sum(D[c]['jga']['looped'] for c in D))
print('unnecessaryPart AC',sum(D[c]['jac']['unnecessaryPart'] for c in D),'GA',sum(D[c]['jga']['unnecessaryPart'] for c in D))
# what would overall be if the 81 positive-gap points were partially recovered
print('\nAC overall 2.74; to reach 3.40 need +%d points over 100 cases'%round((3.40-2.74)*100))
# overall vs other dims within AC: which dims most associated with overall (Pearson)
dims=[k for k in D['WM-01']['jac']['scores'] if k!='overall']
def pear(a,b):
    ma,mb=st.mean(a),st.mean(b); n=sum((x-ma)*(y-mb) for x,y in zip(a,b)); d=(sum((x-ma)**2 for x in a)*sum((y-mb)**2 for y in b))**.5; return n/d if d else 0
o=[ov(c,'jac') for c in D]
print('AC: Pearson(dim, overall):',{k:round(pear([D[c]['jac']['scores'][k] for c in D],o),2) for k in dims})
# gap in overall vs gap in dims: which dim gaps explain overall gap
og=[ov(c,'jga')-ov(c,'jac') for c in D]
print('Pearson(dim gap, overall gap):',{k:round(pear([D[c]['jga']['scores'][k]-D[c]['jac']['scores'][k] for c in D],og),2) for k in dims})
