# Orchestrator review

> **Historical.** This describes the journey architecture, which was retired on 2026-10-13 ([ADR 0021](../adr/0021-understand-label-enrich-decide-reply.md)). The current architecture is in [overview.md](overview.md).

**Question.** Is `orchestration/orchestrator.py` (2,345 lines) large because the domain is complex, or because its
responsibilities are mixed?

**Decision: leave it as one module.**
- Most of its size is documentation, data tables and the legacy path's composition.
- The package is already split along the architecture's seams: types, structural helpers, adapters and transport.
- Splitting the remaining code would add indirection without reducing risk.
- The review found eight specific, small items. They are recorded below for the next orchestrator release.
- No code was changed, and production is unchanged.

Reviewed at `c24662d` (after Phase 11 and the portfolio truth pass).

**Phase 12 update.** Debt items 1 and 2, the two facts the orchestrator duplicated from the engine, are closed. Each now has
one owner, the engine:
- The customer-facing cause label is `conclusion.summary` on the engine's NextAction (`canonical/cause-summary.js`).
  `_CAUSE_LABEL` is deleted (about 115 lines).
- The code-or-model decision is `understand.tokenDecision` (`canonical/token-gate.js`).
  `routing.token_meaning_decision` and its mirrored thresholds are deleted.

`orchestrator.py` is now 2,234 lines. Items 3 to 8 are unchanged and still open. The tables below are the review as
written; the debt table marks what changed ([Phase 12 results](../evaluation/phase-12-results.md)).

## The package as it stands

| File | Lines | Responsibility |
|---|---|---|
| `orchestration/model.py` | 261 | Types: `TurnInput`, `ConversationState` (request-local), `OrchestratorResponse`, trust levels |
| `orchestration/routing.py` | 321 | Structural helpers: brand lookup, code-token shape and normalisation, the route table, the family and token commit rules, the code-or-model question |
| `orchestration/services.py` | 736 | Adapters: the engine (understand and diagnose, HMAC-signed, one 429 retry) and the error-code MCP (bearer); the fake services used by tests |
| `orchestration/deploy/lambda_handler.py` | 163 | Transport: Function URL event → `TurnInput`, bearer check, response JSON |
| `orchestration/orchestrator.py` | 2,345 | Turn decision and legacy composition (below) |

The adapters are already separate and explicit. The orchestrator talks to the engine and the MCP only through the
`DiagnosticService` and `ErrorCodeService` ports.

## Where the 2,345 lines go

| Kind | Lines |
|---|---|
| Comments | 468 |
| Docstrings | about 113 |
| Blank | 127 |
| Code | about 1,640, of which data tables about 185: cause labels 115, safety copy about 55, diagnostic-area taxonomy 15 |

About a quarter of the file explains *why*: each decision point names the authority it defers to (Jev, the MCP, cs/1).
That density is deliberate, and it is what makes the file readable.

## Responsibility map

| Area | Members | Lines | Role |
|---|---|---|---|
| **Turn interpretation** | `_seed_from_cs1`, `_load`, `_reconcile_typed_evidence`, `_established_identity` | about 400 | Builds the request-local turn from the cs/1 block and Jev's typed output: identity, displayed code, model status, symptom presence, typed evidence. Decides nothing that survives the turn |
| **Entry and control flow** | `handle_turn`, `_finish_turn` | about 150 | Scope refusal, then the canonical or legacy branch, then the choke points: unsafe-intent warning, owner note, code-list collapse, pending request, debug state |
| **Canonical transport** | `_canonical_result`, `_canonical_control`, `_flow_canonical`, `_canon_kw`, `_CAUSE_LABEL` (deleted in Phase 12) | about 90 code + 115 data | Passes the engine's merged cs/1 result through. On a canonical turn the engine decided the NextAction and COMPOSE worded it; the orchestrator maps it to the response |
| **Legacy flows** | `_flow_error_code`, `_flow_symptoms`, `_flow_combined`, `_flow_clarify`, `_code_intake_clarify` | about 330 | Turns no canonical journey owns: MCP first for codes, then the engine's legacy diagnose, then reconciliation of the code against the symptom by diagnostic area |
| **Legacy composition and policy** | `_compose_code_only`, `_compose_symptoms_only`, `_compose_combined`, `_compose_unresolved_code_plus_symptoms`, `_compose_model_acquisition`, `_journey_stage`, `_ambiguous_code_reply`, `_code_needs_appliance_clarify` | about 600 | Writes the customer reply on legacy turns from typed state and the engine's result; decides when to ask for the model |
| **Safety presentation** | `_safety_block`, `_owner_safety_note`, `_unsafe_intent_warning`, `_apply_rag_safety`, stop copy | about 170 | Turns a safety class or cause (from cs/1, the MCP or the engine) into fixed copy. It detects no hazards itself |
| **Pending request** | `_pending_for`, `_INTENT_PENDING`, `_MODEL_NEED_RE` | about 70 | Derives the next pending slot from the structured response, never from prose |
| **Module helpers** | `_DIAGNOSTIC_AREAS`, `_areas_of`, `_code_conflicts_with_rag`, `_parts_in_coded_area`, `_clean_checks`, `_component_mention`, … | about 240 | Structural taxonomy and presentation restraint for the legacy path |

## Complexity evidence

No complexity tool is installed, so these were measured with an AST script (branch count = decision points + 1) and
line coverage with a standard-library trace hook over the orchestrator's own test files.

| Measure | Result |
|---|---|
| Top-level | 1 class, 14 module functions, 40 methods |
| Largest / most branched | `_load` 298 lines, 119 branches; `_compose_symptoms_only` 240 / 53; `_compose_combined` 123 / 42, nesting 6; `handle_turn` 104 / 38 |
| Everything else | at most 91 lines and 33 branches |
| Parameters | at most 4 per function |
| Module state | constant tables only; the journey registry is read once at import and fails safe (no registry, every turn legacy) |
| Mutable shared state | none across turns. Within a turn, one request-local `ConversationState` |
| Tests | 17 test files, 31 pytest functions plus 497 check or assert lines. 6 files call internals (`_load`, `_flow_clarify`, `_compose_*`, `_journey_stage`, `_pending_for`) |
| Line coverage | **87.4%** of executable lines. Lowest: `_code_needs_appliance_clarify` 8%, the MCP-unavailable branches of `_flow_combined` 60% |

The four large functions are where the decisions live:
- `_load` is a sequential pipeline of dependent steps. The code value depends on the token decision; the family depends on the model signal and the cross-turn precedence. Each step is commented with its authority.
- The composers are long because each legacy outcome (safety stop, reassurance, recovery, model acquisition, image confirmation, the three part stages) has its own reply shape.

## Alignment with the architecture

The intended role: **the orchestrator coordinates; it is not a second source of diagnostic truth.**

| Check | Result |
|---|---|
| Owns persistent conversation state | **No.** Every turn is built from the request and the cs/1 block ([ADR 0014](../adr/0014-cs1-is-the-only-conversation-state.md)). Nothing survives the invocation |
| Duplicates canonical evidence scoring | **No.** On a canonical turn the engine's NextAction is passed through. The legacy area reconciliation compares the MCP with the engine by taxonomy; it is not journey scoring |
| Detects hazards | **No.** The safety class and cause come from cs/1, the MCP or the engine. The stop and owner-note **copy** is mirrored from the engine, which is debt item 7 |
| Duplicates identity truth | **Partly** at review; **no** after Phase 12. cs/1 identity is read, not re-derived. The token commit rule existed twice, in `routing.token_meaning_decision` and the engine's `token-gate.js`, with mirrored thresholds (debt item 2, now closed) |
| A second policy engine | **Not on canonical turns.** On legacy turns it is the policy: when to ask for the model, which clarify to send. That is bounded by ADR 0015 and shrinks as canonical coverage grows |
| Owns prompt logic | **No.** There are no prompts in the orchestrator, and all model calls are in the engine. Trusted MCP facts go to the engine as a structured dict (`TrustedDiagnosticContext.to_prompt_facts`), and the engine formats them |
| Legacy prose bounded | **Yes.** On a canonical turn the only orchestrator text is the fixed unsafe-intent warning. All other prose is on legacy turns, from typed state |
| Engine and MCP calls are explicit adapters | **Yes**, in `services.py` behind ports |

## Splits considered, and why they were not made

| Candidate | Why not |
|---|---|
| `legacy_compose.py` (the composers) | They read the same request-local turn and call `_safety_block`, `_band`, `_journey_stage` and `_last_assistant_text`. Moving them out means a mixin, or passing the orchestrator in: indirection with the same coupling |
| `turn_interpretation.py` (`_load`) | Its steps share many locals: Jev's decisions, the token decision, the code, the family, the model signal. Split into functions, they would pass most of them around. Named steps inside the class would help reading, and are noted below for the next time `_load` changes |
| `engine_client.py`, `mcp_client.py` | Already exist in substance: `services.py` |
| `safety.py` (presentation) | About 170 lines, mostly copy. The right fix is one copy source shared with the engine (target T9), not a new Python module |

**Any change to `orchestrator.py` is a production release.** CI requires the built image to equal the deployed
reference, so a purely structural edit still needs:
- an image build;
- a reviewed change set;
- the S4R checks;
- a GOLD run.

That cost is worth paying for a fix, not for line count.

## Debt for the next orchestrator release

| # | Item | Evidence | Suggested fix |
|---|---|---|---|
| 1 | **Closed in Phase 12 (12.1a/b).** **`_CAUSE_LABEL` duplicates the engine's cause vocabulary, and has drifted.** Four engine causes have no label: `condenser-water-path`, `drain-hose-or-standpipe`, `water-container-full` (washer-dryer not drying) and `normal-operating-hum` (microwave noisy). On those conclusions the raw key becomes the view's `diagnosis.label` | 199 engine `FAMILY_LABEL` keys compared with 239 orchestrator labels; the other 44 orchestrator-only keys are the washing-machine journeys' causes | The engine sends the summary label with its NextAction, and the orchestrator drops the table. Until then, add the four labels together with a coverage test |
| 2 | **Closed in Phase 12 (12.2a–d).** **The token commit rule is implemented twice** | `routing.token_meaning_decision` (0.70 / 0.55) and `canonical/token-gate.js` (`MIN_CONF`, `MIN_MARGIN`) | Read the engine's `tokenDecision` from the canonical result instead of recomputing it |
| 3 | **18 undeclared request-local attributes** set on `ConversationState` (`st._jev`, `st._uncertainToken`, …) and read through 39 `getattr(..., default)` calls; a typo would fail silently | AST scan | Declare them on a `TurnContext` dataclass |
| 4 | **Dead code:** `_family` with its `_FAMILY` table, and `_intake_text` | No references | Delete |
| 5 | **Repeated call boilerplate:** the engine diagnose call at six sites with near-identical arguments; the MCP call and its evidence block at two | Source | One helper each, explicit about the arguments that differ (`trusted`, `image`, the symptom text) |
| 6 | The model-identifier types `("MODEL", "E_NR", "PNC", "12NC")` are written out seven times | Source | One constant in `model.py` |
| 7 | Stop copy, owner notes and the isolation cue are mirrored from the engine | Comments say "mirrors part-finder" | Target T9: one safety-copy source |
| 8 | `_load` is the densest function (119 branches) | AST scan | Split into named steps when it next changes |

Items 1 and 2 are the ones that matter. Both are a second copy of a fact the engine owns, which is the
seam ADR 0015 is meant to close. The rest are hygiene.

**After Phase 12.** Items 1 and 2 are closed. The engine sends the label and the token decision, and the orchestrator
transports them. The live check on item 2 found one more incorrect commit in the engine's own rule. When Jev could not
place the token at all, mc/1 committed it as the model. The engine now holds that token too, and names it for the
question (12.2c/d). Items 3 to 8 remain as recorded.

## Assessment

- **Can it be understood in ten minutes?** The control flow can: `handle_turn` reads top to bottom (scope, canonical, legacy route, choke points). The legacy composers take longer, because they encode many reply shapes.
- **Do the boundaries reflect the architecture?** Yes, at package level. Inside the file, the canonical path is small and clean. Most of the size is the legacy path, which exists because the canonical engine does not yet own every AC turn.
- **Would it be criticised in an interview?** The two duplicated facts (items 1 and 2) would have been fair criticism; Phase 12 removed them. The file length alone would not survive a look at what is in it.

**Verdict: large, but appropriate.**
