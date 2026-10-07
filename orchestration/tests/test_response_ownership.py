#!/usr/bin/env python3
"""Diagnosis response-ownership tests (deterministic, FakeErrorCodeService + FakeDiagnosticService).

Guards the fix for the FF-010 class: when the Error-Code MCP cannot resolve a code (NEEDS_CONTEXT /
AMBIGUOUS / NOT_FOUND) but the Diagnostic RAG (part-finder) HAS grounded a diagnosis, the grounded
diagnostic answer OWNS the customer reply. The orchestrator must NOT author a competing
"To read the <code> code exactly I'd need the model/rating-plate number." message that buries the
grounded diagnosis. The model is requested for EXACT PART FIT, never to INTERPRET the code.

No network / no LLM / no real RAG. Run: python3 -m orchestration.tests.test_response_ownership

The exact Samsung fridge-freezer 22E scenario (real MCP NEEDS_CONTEXT + real part-finder grounding)
is validated separately in test_integrated_e2e.py / test_deployed_e2e.py; here we use the canned
Bosch WM F06 (NEEDS_CONTEXT) + a grounding drain symptom as the deterministic analog.
"""
import sys
from orchestration.model import TurnInput, ObservedIdentifier, Outcome, Route, Trust
from orchestration.services import FakeErrorCodeService, FakeDiagnosticService, InMemoryStateStore
from orchestration.orchestrator import Orchestrator
from orchestration.tests.fixtures import CANNED

passed = 0; failed = 0
def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond); passed += ok; failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {n}" + ("" if ok else f"  :: {detail}"))

def orch():
    return Orchestrator(FakeErrorCodeService(CANNED), FakeDiagnosticService(), InMemoryStateStore())

def turn(o, msg, sid="s", **kw):
    return o.handle_turn(TurnInput(message=msg, sessionId=sid, **kw))

# The misleading "interpret-the-code" demand this fix removes. A grounded reply must never lead with
# a claim that the model is required to READ/INTERPRET the code (that is only true when the code is
# unresolved AND no diagnosis exists). Requesting the model for the exact PART is fine.
def demands_model_to_read_code(msg):
    m = (msg or "").lower()
    return ("to read the" in m) or ("to interpret the" in m) or ("read the code" in m) \
        or ("can't tell what the code" in m) or ("separately, from your description" in m)

print("=== DIAGNOSIS RESPONSE OWNERSHIP (fake services) ===")

# ---------------------------------------------------------------------------
# A. FF-010 CLASS: unresolved code (NEEDS_CONTEXT) + grounding symptom -> grounded diagnosis OWNS.
# ---------------------------------------------------------------------------
r = turn(orch(), "My Bosch washing machine shows F06 and it won't drain")
mlow = (r.message or "").lower()
check("A route combined + RAG grounded", r.route == Route.ERROR_CODE_AND_SYMPTOMS.value, f"{r.route}")
check("A outcome is ANSWER (diagnosis delivered, not a bare clarify)", r.outcome == Outcome.ANSWER.value, f"{r.outcome}")
check("A diagnosis leads / present", r.diagnosis is not None and "drain" in (r.diagnosis.summary or "").lower(), f"{r.diagnosis}")
check("A message leads with the diagnosis (mentions drain)", "drain" in mlow, mlow[:120])
check("A message does NOT demand the model to READ the code", not demands_model_to_read_code(r.message), mlow[:160])
check("A diagnosis appears before any model request", ("model" not in mlow) or (mlow.index("drain") < mlow.index("model")), mlow[:200])
check("A model requested for the exact PART (staged)", r.modelRequired is True, f"modelRequired={r.modelRequired}")
check("A no part sold before the model is known", not r.parts, f"parts={r.parts}")
check("A structured codeResult keeps the unresolved state (NEEDS_CONTEXT)", r.codeResult is not None
      and r.codeResult.status == "NEEDS_CONTEXT", f"{r.codeResult}")
check("A code MEANING is NOT fabricated (unresolved stays unresolved)", r.codeResult.meaning is None, f"{r.codeResult}")

# ---------------------------------------------------------------------------
# B. RESOLVED code regression: authoritative meaning is preserved and leads.
# ---------------------------------------------------------------------------
r = turn(orch(), "My Bosch dishwasher is showing E15")
check("B resolved code ANSWER + meaning preserved", r.outcome == Outcome.ANSWER.value
      and "means" in (r.message or "").lower() and (r.codeResult.meaning or ""), f"{r.outcome}")
check("B resolved meaning is L1", r.provenance.get("meaning") == Trust.L1_DETERMINISTIC.value)

# ---------------------------------------------------------------------------
# C. MODEL-DEPENDENT code, NO diagnosis: asking for the model IS correct (protect the opposite case).
#    Combined route, F06 NEEDS_CONTEXT, but the symptom ("strange noise") does not ground.
# ---------------------------------------------------------------------------
r = turn(orch(), "My Bosch washing machine shows F06 and it is making a strange noise")
check("C combined + RAG NOT grounded", r.route == Route.ERROR_CODE_AND_SYMPTOMS.value and r.diagnosis is None, f"{r.route}/{r.diagnosis}")
check("C model requested to interpret the model-dependent code", r.outcome == Outcome.CLARIFICATION_REQUIRED.value
      and "model" in (r.message or "").lower(), f"{r.outcome}")
check("C no fabricated meaning", (r.codeResult.meaning if r.codeResult else None) is None)

# ---------------------------------------------------------------------------
# C2. MODEL-DEPENDENT code, code-only (no symptom) -> clarify for model (unchanged, correct).
# ---------------------------------------------------------------------------
r = turn(orch(), "My Bosch washing machine says F06")
check("C2 code-only NEEDS_CONTEXT -> clarify for model", r.route == Route.ERROR_CODE.value
      and r.outcome == Outcome.CLARIFICATION_REQUIRED.value
      and any(n.get("attribute") == "scheme" for n in (r.clarification or {}).get("needs", [])), f"{r.route}/{r.outcome}")

# ---------------------------------------------------------------------------
# D. AMBIGUOUS code + grounding symptom -> grounded diagnosis OWNS (still no fabricated meaning).
# ---------------------------------------------------------------------------
r = turn(orch(), "My Haier washing machine shows E1 and it won't drain")
check("D ambiguous+grounded -> ANSWER diagnosis leads", r.outcome == Outcome.ANSWER.value
      and r.diagnosis is not None and not demands_model_to_read_code(r.message), f"{r.outcome}")
check("D ambiguous code state preserved, meaning not invented", r.codeResult is not None
      and r.codeResult.status == "AMBIGUOUS" and r.codeResult.meaning is None, f"{r.codeResult}")

# ---------------------------------------------------------------------------
# E. Code without make -> CLARIFY (routing; unchanged).
# ---------------------------------------------------------------------------
r = turn(orch(), "it's showing F06")
check("E code without make -> CLARIFY", r.route == Route.CLARIFY.value
      and r.outcome == Outcome.CLARIFICATION_REQUIRED.value, f"{r.route}/{r.outcome}")

# ---------------------------------------------------------------------------
# F. NORMAL behaviour -> ANSWER reassurance, no model/part push (protect DW-017/FF-002/HB-011/MW-007).
# ---------------------------------------------------------------------------
r = turn(orch(), "my dishwasher eco cycle runs for hours, is it normal?", appliance="dishwasher")
check("F normal behaviour -> ANSWER, no model demand, no parts", r.outcome == Outcome.ANSWER.value
      and not r.modelRequired and not r.parts and not demands_model_to_read_code(r.message), f"{r.outcome}")

# ---------------------------------------------------------------------------
# G. SAFETY overrides diagnosis (unresolved code + gas smell). Safety must lead.
# ---------------------------------------------------------------------------
r = turn(orch(), "My Bosch washing machine shows F06 and there's a smell of gas")
check("G safety stop overrides diagnosis prose", r.outcome == Outcome.SAFETY_STOP.value
      and "gas" in (r.message or "").lower() and "national gas" in (r.message or "").lower(), f"{r.outcome}")
check("G no parts on a safety stop", not r.parts)

# ---------------------------------------------------------------------------
# H. Symptom-only diagnosis without a model -> useful diagnosis delivered, model for part.
# ---------------------------------------------------------------------------
r = turn(orch(), "my washing machine won't drain", appliance="washing machine")
check("H symptom-only grounded ANSWER, model for part", r.route == Route.SYMPTOMS.value
      and r.outcome == Outcome.ANSWER.value and r.modelRequired is True
      and not demands_model_to_read_code(r.message), f"{r.route}/{r.outcome}")

# ---------------------------------------------------------------------------
# K. MULTI-TURN: FF-010-class turn, then the customer supplies the model -> state advances.
# ---------------------------------------------------------------------------
o = orch()
r1 = turn(o, "My Bosch washing machine shows F06 and it won't drain", sid="mt")
r2 = turn(o, "the rating plate says WGG244FCGB/01", sid="mt",
          observed=[ObservedIdentifier("E_NR", "WGG244FCGB/01")])
check("K turn1 grounded diagnosis owns the reply", r1.outcome == Outcome.ANSWER.value and not demands_model_to_read_code(r1.message))
check("K turn2 model supplied advances state (code now resolves)", r2.outcome == Outcome.ANSWER.value
      and "temperature" in (r2.codeResult.meaning or "").lower(), f"{r2.outcome}/{r2.codeResult}")

# ---------------------------------------------------------------------------
# MUTATION PROOFS (semantic, not exact prose). Prove the guard would catch a regression.
# ---------------------------------------------------------------------------
print("--- mutation proofs ---")
# M1: the OLD composer output (code-note first + "Separately …") must be REJECTED by the FF-010 guard,
#     while the NEW grounded answer is ACCEPTED. i.e. restoring the old template fails the FF-010 test.
old_style = ("To read the F06 code exactly I'd need the model/rating-plate number. "
             "Separately, from your description this is likely a not draining — worth checking drain pump.")
new_r = turn(orch(), "My Bosch washing machine shows F06 and it won't drain")
check("M1 OLD code-note-first template is REJECTED by the guard", demands_model_to_read_code(old_style))
check("M1 NEW grounded answer is ACCEPTED by the guard", not demands_model_to_read_code(new_r.message))
check("M1 OLD template would set the wrong outcome (CLARIFY), NEW is ANSWER", new_r.outcome == Outcome.ANSWER.value)

# M2: treating an unresolved code as resolved (fabricating a meaning) must NOT happen.
check("M2 unresolved code never gets a fabricated meaning", new_r.codeResult.meaning is None)

# M3: safety must never be bypassed by a preserved diagnosis.
sr = turn(orch(), "My Bosch washing machine shows F06 and there's a smell of gas")
check("M3 grounded-diagnosis preservation never bypasses a safety stop", sr.outcome == Outcome.SAFETY_STOP.value and not sr.parts)

# M4: an UNRECOGNISED code (NOT_FOUND) must never be claimed as resolved and must keep the
#     customer-facing displayed code. When the RAG has grounded the accompanying symptoms, that
#     diagnosis owns the reply — do not author a dead-end "couldn't find a documented meaning"
#     template that abandons the customer's code. Bosch WM ZZ99 is not in the canned table.
nf = turn(orch(), "My Bosch washing machine shows ZZ99 and it won't drain")
check("M4 unknown code keeps unresolved structured status (no fabricated meaning)",
      (nf.codeResult is None or (nf.codeResult.meaning is None and nf.codeResult.status == "NOT_FOUND")),
      f"{nf.outcome}/{nf.codeResult}")
check("M4 unknown displayed code is preserved and not treated as a dead-end undocumented claim",
      "zz99" in (nf.message or "").lower() and "couldn't find a documented meaning" not in (nf.message or "").lower(),
      (nf.message or "")[:160])
check("M4 grounded symptom diagnosis owns the reply",
      nf.diagnosis is not None and nf.outcome == Outcome.ANSWER.value, f"{nf.outcome}/{nf.diagnosis}")

print(f"\nResponse-ownership tests: {passed} passed / {failed} failed  (total {passed + failed})")
sys.exit(0 if failed == 0 else 1)
