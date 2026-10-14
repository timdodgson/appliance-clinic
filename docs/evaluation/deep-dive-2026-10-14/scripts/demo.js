const K=require('/home/user/appliance-clinic/services/diagnosis-engine/ac2/knowledge.js');
const docs=require('/home/user/appliance-clinic/services/diagnosis-engine/knowledge/knowledge-docs.json').docs;
const T=(t)=>{const w=K.words(t),s=new Set();w.forEach((x,i)=>{s.add(x);if(i+1<w.length)s.add(x+' '+w[i+1]);});return s;};
const idx=docs.map(d=>({id:d.knowledgeId,f:d.applianceFamily,t:T([d.label,...d.symptoms,d.faultId.replace(/-/g,' ')].join(' '))}));
for (const [app,text] of [['washing-machine','Samsung WW90T534DAW keeps coming up with 4C after a couple of minutes. Drum is dry. Any ideas before I call someone out?'],['washing-machine','My indesit washing machine fills with water and drains but the drum just doesn\'t go round at all. Its an IWC something. Had it about 9 years. Is it worth fixing?'],['dishwasher','My Samsung dishwasher DW60M6050FS keeps showing 4C and beeping, won\'t do anything'],['washing-machine','w/m wont spinn pls help'],['washing-machine','washing machine won\'t spin']]) {
  const q=T(text); console.log('\nQ:',text.slice(0,80),'| query terms:',[...q].join(','));
  for (const r of K.retrieve({appliance:app,text,limit:5})) { const e=idx.find(x=>x.id===r.knowledgeId); console.log('  ',r.score,r.knowledgeId,'matched:',[...q].filter(t=>e.t.has(t)).join('/')); }
}
// generic-term document frequency (no IDF in scoring)
for (const w of ['drum','water','keeps','not working','noise','smell','wont','after']) console.log('docs containing term',JSON.stringify(w),':',idx.filter(e=>e.t.has(w)).length);
