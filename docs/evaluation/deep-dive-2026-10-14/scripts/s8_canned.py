exec(open('load.py').read())
import collections,re
# replies made of a canned card only (identical text appearing in >=3 different conversations)
cnt=collections.Counter(); where=collections.defaultdict(set)
for c,d in D.items():
    for t in d['ac']['transcript']:
        if t['role']=='assistant': cnt[t['text'].strip()]+=1; where[t['text'].strip()].add(c)
canned=[(t,n) for t,n in cnt.items() if len(where[t])>=2]
for t,n in canned: print(n,'replies in',sorted(where[t]),'|',t[:140].replace('\n',' '))
# repeated identical reply within same conversation
rep=[c for c,d in D.items() if (lambda a: len(a)!=len(set(a)))([t['text'].strip() for t in d['ac']['transcript'] if t['role']=='assistant'])]
print('\nconversations with a verbatim-identical assistant reply repeated:',rep)
