'use strict';

/**
 * Deterministic OUTPUT-containment boundary for WhichPart — PURE functions, no
 * Lambda / network / LLM dependencies, so they are unit-testable in isolation.
 *
 *   outputTripwire(reply)  — OUTPUT containment. Runs on the composed reply
 *      BEFORE it is streamed to the client. If the reply shows evidence of
 *      security-policy disclosure or a structurally-impossible WhichPart answer
 *      (source code, truth/decision tables, rule dumps), the reply is discarded
 *      and replaced with the fixed appliance-only refusal.
 *
 * The INPUT scope/security decision (is this an appliance request, a prompt
 * attack, an unrelated request, or ambiguous?) is NO LONGER made here by regex.
 * It is a typed decision of the single Jev UNDERSTAND pass
 * (intent._requestClass — see jev-understand.js): meaning is decided once by Jev,
 * and part-finder-lambda applies the deterministic consequence. This module now
 * holds only the deterministic OUTPUT containment + the fixed refusal text.
 *
 * Design stance (matches the security review): this does NOT "solve" prompt
 * injection. It reduces, contains and monitors. The output patterns are
 * intentionally chosen to be alien to genuine appliance-repair phrasing so real
 * replies are not tripped — the real protection is the minimal COMPOSE context
 * + this output tripwire, now with Jev owning the input meaning.
 */

// Fixed, safe response used for BOTH a Jev-classified scope refusal and an
// output-tripwire trip.
const REFUSAL_TEXT =
  "I can only help with domestic appliance faults and spare parts, so I can't help with that. If you've got a problem with an appliance, tell me the make, model and what it's doing and I'll help you find the right part.";

// OUTPUT markers — evidence the reply leaked policy or completed an off-topic
// task. Conservative: legitimate appliance terminology must not trip these.
const TRIPWIRE_PATTERNS = [
  { reason: 'prompt-disclosure', re: /system prompt|developer (instructions?|prompt)|instruction hierarchy|source[- ]?authority|source hierarchy/i },
  { reason: 'rule-disclosure', re: /\brule id\b|required behaviou?r|forbidden behaviou?r/i },
  { reason: 'policy-table', re: /\b(decision|truth|conflict[- ]?resolution|policy)[- ]?(table|diff)\b/i },
  { reason: 'logic-task', re: /\bproposition\b|logically (impossible|coexist|consistent)/i },
  { reason: 'code', re: /```|\bdef \w+\s*\(|\bimport \w+|console\.log\s*\(|\bprint\s*\(|function\s+\w+\s*\(/ },
];

function outputTripwire(reply) {
  const text = String(reply || '');
  for (const { reason, re } of TRIPWIRE_PATTERNS) {
    if (re.test(text)) return reason;
  }
  // Structural: WhichPart replies are prose + bullet lists + [links], never
  // multi-row markdown tables. 3+ table rows => a dumped table, not a reply.
  const pipeRows = (text.match(/^\s*\|.*\|\s*$/gm) || []).length;
  if (pipeRows >= 3) return 'table';
  return null;
}

module.exports = { outputTripwire, REFUSAL_TEXT, TRIPWIRE_PATTERNS };
