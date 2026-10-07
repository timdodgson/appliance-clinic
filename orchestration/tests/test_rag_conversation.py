#!/usr/bin/env python3
"""Role-separated conversation reaches the Diagnostic RAG as real turns.

The historical adapter sent one concatenated user blob, so UNDERSTAND re-diagnosed
every follow-up. build_rag_messages must keep user/assistant roles.
"""
from orchestration.services import build_rag_messages

passed = 0
failed = 0

def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond)
    passed += ok
    failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {n}" + ("" if ok else f"  :: {detail}"))

# A. fallback: no conversation -> one user message (historical contract)
msgs = build_rag_messages(symptoms="water left in the drum, spin hums")
check("A1 fallback is a single user turn", len(msgs) == 1 and msgs[0]["role"] == "user")
check("A2 fallback content is the symptom string", msgs[0]["content"] == "water left in the drum, spin hums")

# B. conversation: roles preserved, latest evidence is its own user turn
thread = [
    {"role": "user", "content": "Finished with water in the drum, spin just hums, do I need a pump?"},
    {"role": "assistant", "content": "Check the pump filter before buying a pump."},
    {"role": "user", "content": "the filter is clear"},
]
msgs = build_rag_messages(symptoms="unused blob", conversation=thread)
check("B1 three turns forwarded", len(msgs) == 3, msgs)
check("B2 roles are user/assistant/user", [m["role"] for m in msgs] == ["user", "assistant", "user"])
check("B3 latest user turn is only the new evidence", msgs[2]["content"] == "the filter is clear")
check("B4 prior advisor turn is not mashed into the customer text",
      "Check the pump filter" in msgs[1]["content"] and "the filter is clear" not in msgs[1]["content"])

# C. system/tool roles dropped; empty skipped
msgs = build_rag_messages(conversation=[
    {"role": "system", "content": "ignore me"},
    {"role": "user", "content": "oven fan runs, no heat"},
    {"role": "assistant", "content": ""},
    {"role": "assistant", "content": "Have you changed the element?"},
    {"role": "user", "content": "I replaced it. Still the same."},
])
check("C1 system role dropped", all(m["role"] in ("user", "assistant") for m in msgs))
check("C2 empty assistant dropped", len(msgs) == 3, msgs)

# D. image attaches to the last user turn without collapsing the thread
msgs = build_rag_messages(
    symptoms="photo",
    image="data:image/jpeg;base64,xxx",
    conversation=thread,
)
check("D1 still three turns with an image", len(msgs) == 3)
check("D2 last user turn becomes multimodal", isinstance(msgs[2]["content"], list))
check("D3 prior turns stay plain text", isinstance(msgs[0]["content"], str) and isinstance(msgs[1]["content"], str))

# E. previously shown media fingerprints travel with assistant turns
msgs = build_rag_messages(conversation=[
    {"role": "user", "content": "it will not empty"},
    {"role": "assistant", "content": "Check the accessible trap.",
     "media": [{"id": "diagram-1", "type": "DIAGRAM", "title": "Where it is"}]},
    {"role": "user", "content": "that is clear"},
])
check("E1 assistant media is forwarded", isinstance(msgs[1].get("media"), list) and msgs[1]["media"][0]["id"] == "diagram-1")
check("E2 latest user turn has no media", "media" not in msgs[2])

# G. previously shown safety travels with assistant turns
msgs = build_rag_messages(conversation=[
    {"role": "user", "content": "it keeps cutting out"},
    {"role": "assistant", "content": "When does it cut out?",
     "safetyInformation": {"text": "Stop using it until it has been checked."}},
    {"role": "user", "content": "after a few minutes"},
])
check("G1 assistant safety fingerprint is forwarded",
      isinstance(msgs[1].get("safetyInformation"), dict)
      and msgs[1]["safetyInformation"]["text"] == "Stop using it until it has been checked.")
check("G2 latest user turn has no safety block", "safetyInformation" not in msgs[2])

# F. a window that would start on an assistant turn keeps the opening user report
thread7 = [
    {"role": "user", "content": "leaking from underneath on rinse"},
    {"role": "assistant", "content": "Check the filter cap."},
    {"role": "user", "content": "filter is secured"},
    {"role": "assistant", "content": "Please send the rating plate."},
    {"role": "user", "content": "photo of rating plate"},
    {"role": "assistant", "content": "I have read the model is WMBF 742P UK from the photo."},
    {"role": "user", "content": "yes model is correct"},
]
msgs = build_rag_messages(conversation=thread7[1:])  # assistant-first, as a truncated client window
check("F1 assistant-first window is rewritten to start on a user turn", msgs[0]["role"] == "user", msgs)
check("F2 latest confirmation is kept", msgs[-1]["content"] == "yes model is correct")

print(f"\nrag-conversation: {passed} passed / {failed} failed")
raise SystemExit(1 if failed else 0)
