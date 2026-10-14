import json,glob,os
E='/home/user/appliance-clinic/evaluation'
R=E+'/rebuild/out/independent-100-21.16'
G=E+'/independent-100/out'
cases={c['id']:c for c in json.load(open(E+'/independent-100/cases.json'))['cases']}
def j(p):
    try: return json.load(open(p))
    except Exception: return None
D={}
for cid,c in cases.items():
    D[cid]=dict(case=c,
      ac=j(f'{R}/conversations/ac3/{cid}.json'),
      ga=j(f'{G}/conversations/ga/{cid}.json'),
      jac=j(f'{R}/judge/primary/{cid}.ac3.json'),
      jac2=j(f'{R}/judge/second/{cid}.ac3.json'),
      jga=j(f'{G}/judge/primary/{cid}.ga.json'),
      pw=j(f'{R}/judge/pairwise-ac3-ga/{cid}.json'))
