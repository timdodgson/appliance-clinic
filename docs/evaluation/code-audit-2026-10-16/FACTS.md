# Facts for the refactor (code + saved data only, 2026-10-16)

Sources: the code; live logs of the Dyson chat; saved per-turn audits of the 100-case runs
(`evaluation/rebuild/out/rag-vs-plain/conversations/ours-opus` = our pipeline on Opus, `plain-opus` = Opus alone).

1. Reply length: our pipeline median 320 words (279/308 replies over 150); Opus alone median 372 (240/254 over
   150). Our prompt asks for "two to four" checks as a numbered list (`turn.js:233`, `reasoner.js:40`). Long replies
   are Opus's default too, not only our prompt.
2. Claim checker (`verifier.js`): deleted sentences in 159/308 replies (253 sentences); rewrote 0 times. At least 54
   of 253 were instructions (16) or mostly the customer's own words (38) (word-overlap test). The other 199 are not
   classified. Dyson chat: deleted the rinse instruction in turn 1 and turn 2 (logs).
3. Paragraph breaks: removed from every reply by `safety.js:187` (and `verifier.js:235` when it deletes).
4. Parts, 38 cases needing one: 1 shown. 23 never narrowed by Jev (13 Jev said "not yet", 5 no check recorded so
   never asked, 5 not asked); 5 blocked because a hazard (e.g. burning smell) blocks parts for the whole chat
   (`turn.js:449`); 3 no model recorded; 6 looked up, catalogue had no matching part for that model.
5. When Jev did narrow (19 cases) it matched the true fault in most; clearly wrong in 2 (VC-02 battery, FF-06
   compressor).
6. Dyson: never narrowed (stage 1 all chat). Even if narrowed, `matchParts` returns nothing for the note's wording
   "…(HEPA) filters" although the catalogue lists V6 filters (£15, £18, £19) — tested.
7. Photos: dropped (`runtime.js:44` does not pass `image`).
8. Help media: 21 items for 17 of 171 notes; shown in 17/308 replies.
9. Not used in live: `compose.js`, `evidence.js`, `jevChooses` (switched off); `reply.js` prompt (only the ablation).
10. Speed: median 22.9 s per turn, max 40.6 s; the BFF gives up at 45 s.
11. Scoring: judge scores 0–4 overall impressions (`judge.mjs:37`); no item-by-item check of the expected answer, no
    length/layout dimension.

Not known from existing data: what caused "1. 2. 3. 4." in the Dyson reply (the raw draft is not logged); whether
removing or changing any step makes answers better.

Corrections to earlier statements: "Opus alone would give the Google answer" — false (fact 1). "Jev labels usually
wrong" — false (fact 5). "~31/40 deletions wrong" — my judgement, replaced by fact 2.
