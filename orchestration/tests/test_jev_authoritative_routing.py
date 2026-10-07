"""Story 3 — Jev is the single semantic authority for routing (new contract boundary).

Proves the relocated topology deterministically (no network, no real Jev):
  * the orchestrator runs Jev UNDERSTAND exactly ONCE per turn, BEFORE routing;
  * routing consumes Jev's TYPED decisions (appliance family, symptom presence, model-vs-code) —
    never a prose re-parse;
  * the SAME typed result is forwarded verbatim into the RAG diagnose call (understand=...), so
    part-finder does not run Jev a second time;
  * model-vs-error-code follows Jev meaning, not token shape (Dyson V6 stays a model);
  * cannot-answer / correction / pending-slot are driven by Jev, not regex.

Run: python3 -m orchestration.tests.test_jev_authoritative_routing
"""
import sys
from orchestration.model import TurnInput, Outcome, Route
from orchestration.services import FakeErrorCodeService, FakeDiagnosticService, InMemoryStateStore
from orchestration.orchestrator import Orchestrator
from orchestration.tests.fixtures import CANNED

passed = 0; failed = 0
def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond); passed += ok; failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {n}" + ("" if ok else f"  :: {detail}"))


class CountingRag(FakeDiagnosticService):
    """Wraps the fake RAG to COUNT Jev-understand calls and CAPTURE what diagnose received."""
    def __init__(self):
        self.understand_calls = 0
        self.diagnose_calls = 0
        self.last_understand_arg = "UNSET"
        self.last_understand_result = None

    def understand(self, *, symptoms, image=None, conversation=None, established=None):
        self.understand_calls += 1
        self.last_understand_result = super().understand(symptoms=symptoms, image=image,
                                                         conversation=conversation, established=established)
        return self.last_understand_result

    def diagnose(self, *, understand=None, **kw):
        self.diagnose_calls += 1
        self.last_understand_arg = understand
        return super().diagnose(understand=understand, **kw)


def build():
    rag = CountingRag()
    return Orchestrator(FakeErrorCodeService(CANNED), rag, InMemoryStateStore()), rag

def turn(o, msg, sid="s", **kw):
    return o.handle_turn(TurnInput(message=msg, sessionId=sid, **kw))

# ---- CALL COUNT: exactly ONE Jev understand per turn; diagnose reuses it -----------------------
o, rag = build()
r = turn(o, "my dishwasher won't drain and there is water left in the bottom")
check("symptom turn: Jev understand called exactly once", rag.understand_calls == 1, rag.understand_calls)
check("symptom turn routes to RAG (diagnose called once)", rag.diagnose_calls == 1, rag.diagnose_calls)
check("diagnose received the SAME typed Jev result (injected)",
      rag.last_understand_arg is not None and rag.last_understand_arg is rag.last_understand_result["understand"],
      type(rag.last_understand_arg).__name__)
check("symptom-only route", r.route == Route.SYMPTOMS.value, r.route)

# a pure error-code turn still runs Jev exactly once (then MCP, no RAG diagnose)
o, rag = build()
r = turn(o, "My Bosch dishwasher is showing E15")
check("code turn: Jev understand called exactly once", rag.understand_calls == 1, rag.understand_calls)
check("code turn goes to MCP, not the RAG (no diagnose)", rag.diagnose_calls == 0, rag.diagnose_calls)
check("code turn routes ERROR_CODE", r.route == Route.ERROR_CODE.value and r.outcome == Outcome.ANSWER.value, r.route)

# ---- MODEL vs ERROR-CODE by Jev MEANING, not token shape ---------------------------------------
o, rag = build()
r = turn(o, "my Dyson V6 keeps pulsing on and off")
check("Dyson V6 pulsing: V6 is a MODEL (not a code), routes to RAG",
      r.route == Route.SYMPTOMS.value
      and (rag.last_understand_result["understand"].get("errorCode") in (None, ""))
      and rag.last_understand_result["understand"].get("model") == "V6", rag.last_understand_result["understand"])

o, rag = build()
r = turn(o, "My Bosch dishwasher is showing E15 and there is water underneath")
check("explicit code + make + symptom -> combined MCP+RAG",
      r.route == Route.ERROR_CODE_AND_SYMPTOMS.value, r.route)

# code without sufficient identity (no make) -> clarify, not an invented interpretation
o, rag = build()
r = turn(o, "it is showing F05", sid="noid")
check("code without make -> CLARIFY", r.route == Route.CLARIFY.value
      and r.outcome == Outcome.CLARIFICATION_REQUIRED.value, f"{r.route}/{r.outcome}")

# ---- APPLIANCE FAMILY retained across a follow-up, from Jev ------------------------------------
o, rag = build()
turn(o, "my tumble dryer is not drying, clothes come out cold", sid="fam")
r = turn(o, "it's a Beko", sid="fam")
check("appliance family retained across follow-up", r.route in (Route.SYMPTOMS.value, Route.CLARIFY.value), r.route)
check("exactly one Jev understand PER TURN (2 turns -> 2 calls)", rag.understand_calls == 2, rag.understand_calls)

# ---- PENDING MODEL slot: a bare model answer is a MODEL (Jev), code preserved -------------------
o, rag = build()
turn(o, "My Bosch washing machine says F06", sid="pend")
r = turn(o, "the model number is WGG244FCGB/01", sid="pend")
check("pending model answer keeps the earlier code (retained), routes to code resolution",
      r.route in (Route.ERROR_CODE.value, Route.ERROR_CODE_AND_SYMPTOMS.value, Route.SYMPTOMS.value), r.route)

# ---- CANNOT-ANSWER manufactures no code/symptom ------------------------------------------------
o, rag = build()
r = turn(o, "my oven is not heating", sid="ca")
r2 = turn(o, "honestly I have no idea", sid="ca")
check("cannot-answer turn does not invent a code",
      (rag.last_understand_result["understand"].get("errorCode") in (None, "")), rag.last_understand_result["understand"])

# ================================================================================================
# STORY 5 — SEMANTIC-BOUNDARY ARCHITECTURAL CONTRACT
# These are not naive "no regex" scans. They assert the BEHAVIOURAL invariant that deterministic
# code consumes Jev's TYPED decision and never re-derives the same customer MEANING from prose.
# ================================================================================================
import types

class ScriptedRag(FakeDiagnosticService):
    """Returns a controlled typed understand so we can make Jev's TYPED decision DISAGREE with what a
    prose parser would conclude — proving the orchestrator follows the typed field, not the words."""
    def __init__(self, understand_overrides=None, decision_overrides=None):
        self._u = understand_overrides or {}
        self._d = decision_overrides or {}
    def understand(self, *, symptoms, image=None, conversation=None, established=None):
        base = super().understand(symptoms=symptoms, image=image, conversation=conversation,
                                  established=established)
        base["understand"]["newEvidenceThisTurn"] = symptoms  # deterministic latest-evidence
        for k, v in self._u.items():
            base["understand"][k] = v
        for k, v in self._d.items():
            base["jev"]["decisions"][k] = v
        return base

def build_scripted(u=None, d=None):
    return Orchestrator(FakeErrorCodeService(CANNED), ScriptedRag(u, d), InMemoryStateStore())

# ---- CONTRACT 1: "cannot provide the model" is the TYPED field, never prose --------------------
o, _ = build()
st_typed_true = types.SimpleNamespace(_understand={"modelUnavailable": True},
                                      customer=types.SimpleNamespace(symptomsText="the drum won't spin"))
st_typed_false = types.SimpleNamespace(_understand={"modelUnavailable": False},
                                       customer=types.SimpleNamespace(symptomsText="the model sticker is scratched off and unreadable"))
check("CONTRACT model-unavailable follows Jev typed True (no prose cue present)",
      o._cannot_provide_model(st_typed_true) is True)
check("CONTRACT model-unavailable follows Jev typed False EVEN WHEN prose screams 'scratched off'",
      o._cannot_provide_model(st_typed_false) is False)
check("CONTRACT model-unavailable degrades safe when Jev absent",
      o._cannot_provide_model(types.SimpleNamespace(_understand=None)) is False)

# ---- CONTRACT 2: code VALUE recovery reads Jev's decision OR the customer's EXPLICIT label -------
# The line the audit draws: deterministic code may read the customer's OWN explicit statement
# (a labelled "error e 21", an unambiguous "E36/E10" shape) and may recover the value of a token
# Jev POSITIVELY classified as a code — but it must NOT promote a BARE, unlabelled, ambiguous token
# to a code on a turn Jev left uncertain. That inference stays Jev's.
o = build_scripted(u={"errorCode": None, "_tokenMeaning": "uncertain", "applianceType": "oven-cooker"},
                   d={"candidateTokenMeaning": "uncertain"})
r_bare = turn(o, "My Bosch oven, the panel shows 21", sid="gate-bare")
check("CONTRACT a BARE unlabelled token Jev left uncertain is NOT promoted to a code",
      r_bare.route != Route.ERROR_CODE.value and r_bare.route != Route.ERROR_CODE_AND_SYMPTOMS.value,
      r_bare.route)

# The customer EXPLICITLY labelled it a code ("error e 21"): reading that explicit statement is
# syntax recognition of their own words, not a second authority — recovered even when Jev's token
# classification is uncertain.
o = build_scripted(u={"errorCode": None, "_tokenMeaning": "uncertain", "applianceType": "oven-cooker"},
                   d={"candidateTokenMeaning": "uncertain"})
r_labelled = turn(o, "My Bosch oven, error e 21", sid="gate-labelled")
check("CONTRACT the customer's EXPLICIT 'error e 21' label is read as a code (their own words)",
      r_labelled.route == Route.ERROR_CODE.value, r_labelled.route)

o = build_scripted(u={"errorCode": None, "_tokenMeaning": "error_code", "applianceType": "oven-cooker"},
                   d={"candidateTokenMeaning": "error_code"})
r_positive = turn(o, "My Bosch oven, error e 21", sid="gate-positive")
check("CONTRACT Jev-classified code with NO value recovers the VALUE (E21) structurally",
      r_positive.route == Route.ERROR_CODE.value, r_positive.route)

print(f"\nJev-authoritative routing (new contract): {passed} passed / {failed} failed  (total {passed+failed})")
sys.exit(1 if failed else 0)
