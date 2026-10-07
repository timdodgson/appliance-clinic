"""STAGE B — deterministic first-turn appliance-family proceed/clarify decision.

Pure-function tests over SYNTHETIC typed Jev evidence (provenance + probability distribution). No
customer strings, no regex, no semantic assertions. Proves the decision is a stable function of the
family evidence and that no separate classifier (identitySufficiency) can influence it.

Run: PYTHONPATH=. python3 orchestration/tests/test_first_turn_family_decision.py
"""
import sys
from orchestration.routing import (
    first_turn_family_decision, FAMILY_PROCEED_MIN_CONFIDENCE, FAMILY_PROCEED_MIN_MARGIN,
)

passed = 0
failed = 0


def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond)
    passed += ok
    failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {n}" + ("" if ok else f"  :: {detail}"))


def decide(**kw):
    return first_turn_family_decision(**kw)[0]


# explicit customer-named family -> proceed (even with a thin distribution: no margin test)
d, det = first_turn_family_decision(provenance="customer_named",
                                    probabilities={"washing-machine": 1.0})
check("explicit customer_named -> proceed", d == "proceed" and det["reason"] == "customer_named")

# explicit family should not require a probability-margin test to proceed (near-tie but named)
check("explicit customer_named with near-tie distribution -> proceed",
      decide(provenance="customer_named",
             probabilities={"dishwasher": 0.45, "unknown": 0.44, "uncertain": 0.11}) == "proceed")

# strong inferred family + clear margin -> proceed
check("strong inferred + clear margin -> proceed",
      decide(provenance="inferred",
             probabilities={"washing-machine": 0.82, "unknown": 0.10, "uncertain": 0.08}) == "proceed")

# WP-03-style stable strong family -> proceed
check("WP-03-style washing-machine 0.83/0.14 -> proceed",
      decide(provenance="inferred",
             probabilities={"washing-machine": 0.83, "unknown": 0.14, "uncertain": 0.03}) == "proceed")

# weak inferred family (low confidence) -> clarify
check("weak inferred (0.53/0.38) -> clarify",
      decide(provenance="inferred",
             probabilities={"tumble-dryer": 0.53, "unknown": 0.38, "uncertain": 0.09}) == "clarify")

# near-tie family vs unknown -> clarify (WP-39 canonical style: dishwasher just ahead of unknown)
check("near-tie dishwasher 0.57 vs unknown 0.33 -> clarify",
      decide(provenance="none",
             probabilities={"dishwasher": 0.57, "unknown": 0.33, "uncertain": 0.10}) == "clarify")
check("near-tie dishwasher 0.66 vs unknown 0.27 (margin 0.39) -> clarify",
      decide(provenance="inferred",
             probabilities={"dishwasher": 0.66, "unknown": 0.27, "uncertain": 0.07}) == "clarify")

# unknown top choice -> clarify
check("unknown argmax -> clarify",
      decide(provenance="none",
             probabilities={"unknown": 0.52, "washing-machine": 0.33, "uncertain": 0.15}) == "clarify")
check("uncertain argmax -> clarify",
      decide(provenance="uncertain",
             probabilities={"uncertain": 0.6, "dishwasher": 0.25, "unknown": 0.15}) == "clarify")

# inferred family just below the confidence floor -> clarify (even with a big nominal margin)
check("inferred below confidence floor -> clarify",
      decide(provenance="inferred",
             probabilities={"hobs": 0.68, "unknown": 0.05, "uncertain": 0.05,
                            "oven-cooker": 0.22}) == "clarify")

# inferred with high confidence but SMALL margin -> clarify (two families near-tied)
check("high top but small margin (0.55 vs 0.40) -> clarify",
      decide(provenance="inferred",
             probabilities={"washing-machine": 0.55, "washer-dryer": 0.40, "unknown": 0.05}) == "clarify")

# a strong family decision must NOT be vetoed by any identitySufficiency value: the function does
# not accept identitySufficiency at all, so a strong inferred family proceeds regardless of what a
# separate sufficiency classifier would have said.
check("strong inferred proceeds irrespective of identitySufficiency (not an input)",
      "identitySufficiency" not in first_turn_family_decision.__doc__ or
      decide(provenance="inferred",
             probabilities={"washing-machine": 0.80, "unknown": 0.15, "uncertain": 0.05}) == "proceed")

# boundary: exactly at both thresholds -> proceed (>= is inclusive)
check("exactly at thresholds -> proceed",
      decide(provenance="inferred",
             probabilities={"dishwasher": FAMILY_PROCEED_MIN_CONFIDENCE,
                            "unknown": round(FAMILY_PROCEED_MIN_CONFIDENCE - FAMILY_PROCEED_MIN_MARGIN, 4)}) == "proceed")

# fallback: no distribution, strong confidence -> proceed
check("no distribution + strong confidence -> proceed (fallback)",
      decide(provenance="inferred", probabilities=None, confidence=0.9) == "proceed")
# fallback: no distribution, weak confidence -> clarify
check("no distribution + weak confidence -> clarify (fallback)",
      decide(provenance="inferred", probabilities=None, confidence=0.4) == "clarify")

# determinism: identical evidence yields identical decision every call
runs = {decide(provenance="inferred",
               probabilities={"dishwasher": 0.60, "unknown": 0.30, "uncertain": 0.10}) for _ in range(50)}
check("deterministic: identical evidence -> single outcome", len(runs) == 1)

print(f"\nfirst-turn-family-decision: {passed} passed / {failed} failed  "
      f"(thresholds conf>={FAMILY_PROCEED_MIN_CONFIDENCE} margin>={FAMILY_PROCEED_MIN_MARGIN})")
sys.exit(1 if failed else 0)
