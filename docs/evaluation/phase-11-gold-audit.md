# Phase 11: does GOLD need new coverage?

Rule: add a scenario only when the behaviour is important and GOLD does not already cover it. The rest belongs in contract, state or regression tests.

| Phase 11 change | Already covered? | Decision |
|---|---|---|
| F15 legacy guidance leak (S4R path) | Not an AC GOLD path: S4R's `/part-finder` runs the legacy pipeline directly | Regression test `f15-legacy-guidance-leak.test.mjs` plus a live S4R probe. No GOLD change |
| ADR 0017 signed engine fields | Transport security, not conversation quality | Contract tests `engine-auth.test.mjs` and `test_engine_signing.py`, plus live forged-request check. No GOLD change |
| ADR 0014 one conversation state | Every multi-turn GOLD scenario exercises cross-turn identity and evidence | State-transition tests `test_one_conversation_state.py`. No GOLD change |
| D2 code or model near the threshold | **Yes:** G2-EC-01 (a bare code with a misspelt brand, then "I said that already") is the production shape | Unit and flow regressions (`phase11-code-or-model.test.mjs`, five shapes). No new scenario |
| D1 repeated follow-up after a conclusion | **No.** G2-WM-10 covers repeated questions and a repeated full conclusion, not the same short follow-up twice | **Added G2-MW-06** (a conclusion, then replies that add nothing new). Judged semantically; no string matching |

Result: **GOLD-v2.4, 56 scenarios** (GOLD-v2.3 unchanged plus G2-MW-06). Rubric `gold-v2-rubric-v3` and the pass rule are unchanged. Nothing removed or rewritten.
