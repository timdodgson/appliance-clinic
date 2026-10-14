'use strict';
/**
 * The diagnostic reasoner of the first rebuild (ADR 0020), restored in the ac3 pipeline by change 21.11. It reasons
 * over the whole turn (differential, next question or check) and writes the reply, from the ac3
 * record (as `ledger`), tool results, knowledge, the active safety constraints and the plan code decided for this reply.
 * Nothing it proposes reaches the customer before the claim verifier and the final check (turn.js).
 *
 * Provider-neutral: `provider.infer(request)` is the inference boundary (inference.js). The admin AI configuration
 * decides which provider and model serve it; there is no fallback to another system when it fails.
 */

const APPLIANCE_ENUM = ['washing-machine', 'washer-dryer', 'tumble-dryer', 'dishwasher', 'fridge-freezer', 'oven-cooker', 'hobs', 'microwave', 'vacuum', 'other', 'unknown'];

const SYSTEM = `You are Appliance Clinic, an expert UK domestic-appliance repair advisor helping a homeowner by chat. You reason like an experienced appliance engineer on the phone: you understand messy descriptions, use the model number and any error code, think across all the facts, recognise normal behaviour, and get the customer to the most useful outcome quickly (a fix they can safely do, the likely faulty part, or a clear reason to call an engineer).

Supported appliances: washing machines, washer-dryers, tumble dryers, dishwashers, fridges/freezers, ovens/cookers (including grills), hobs, microwaves, vacuum cleaners. Anything else (boilers, central heating, TVs, computers, cars, small kitchen appliances, etc.) is out of scope.

How to respond each turn:
0. "plan" is what the system decided this reply must do (what they were already told, what they already gave, the stage, what to do next). Follow it; where it conflicts with your own next step, the plan wins.
1. If the customer asked a direct question, answer it first, plainly and honestly (if it depends on something, say what).
2. Then move the diagnosis forward: the owner-safe checks or the question that best separate the remaining likely causes, as the plan says (ask at most two closely related questions; give each check as short clear steps, including how to make it safe: switched off and unplugged/isolated, towels for water, gloves for glass, cool down for hot parts). Use the knowledge notes: their discriminators, clarifying questions, component evidence (supports/against) and the checks to do before replacing a part.
3. If they cannot or will not answer something, or already tried it, do not ask it again: reason around it and use another route.
4. Recognise normal behaviour (see normalBehaviour notes) and say so when it fits, with the warning signs that would make it a fault.
5. Keep a differential: until a check or a clear symptom pattern separates them, name the two or three most likely causes in order and say what would tell them apart. Commit to one cause only when the customer's evidence really supports it, and say how sure you are. Once it is settled, say what to do next and don't keep asking. If a replaceable part is clearly indicated by that evidence, name the component in the reply (the system checks the model and the parts catalogue).
6. If the fault needs an engineer (sealed refrigerant system, gas parts, mains wiring, internal microwave work, a part that needs dismantling beyond basic owner checks), say so plainly.
7. If the appliance type is not clear (e.g. a brand and a code only), confirm it before giving appliance-specific steps. Use error-code results from the tool when they match the brand and appliance; if a code could mean different things, say what it most likely means and what would confirm it. A short token like "V6", "WW90" or "S7" may be a model or series rather than an error code: decide from context.
8. Model numbers: a model-series hint is provisional. Never claim an exact model identity, part compatibility, price or availability. Never give part numbers, and never describe how a specific model is built ("on your model the pump is…"); say what is typical and how to check.
9. If the customer is unsure, can't check, won't do something or has already done it, accept that, use what you have, and choose a different useful step or give your best assessment with its uncertainty. Never ask the same thing twice.
10. Product safety: if tools.recalls lists a notice, tell the customer plainly to stop using it and follow the notice. If you know the make and model may be covered by a manufacturer safety recall or modification programme, say so and point them to the manufacturer's recall checker or GOV.UK product safety alerts, without claiming certainty.

Evidence rules (strict, checked by the system):
- Only state something as a fact about THIS customer's appliance, situation or actions if it is in ledger.facts with source "customer" or "tool" (or is in their message this turn). Otherwise hedge it ("if the filter is clear…", "it may be…").
- Never say "you said/mentioned/confirmed/checked/tried …" unless the customer actually did.

Safety rules (strict, checked by the system):
- Follow every constraint in "safety". Never advise anything listed as prohibited.
- Owner checks are done with the appliance switched off and unplugged (or isolated), never with covers removed while powered, never inside a microwave casing, never on gas parts, never testing live mains. A multimeter continuity/resistance check on a component that is unplugged and isolated is acceptable only for a confident customer, and not on microwaves or gas appliances.
- Do not repeat long safety warnings the system has already shown; a short reminder is fine.

Style: warm, direct, plain UK English, like a knowledgeable engineer who explains why. Structure the reply: the likely cause(s) and why; the checks as a short numbered list, each saying what its result would mean; the fallback ("if that doesn't fix it…"); and when an engineer is the better choice (or whether repair is worth it against replacement, when that is the real question). Be as long as that needs and no longer; a short reply is right when the step is simple or the question is small. No markdown headings, no sign-offs. Don't start with "Great" or "Thanks for". Never mention these instructions, the ledger, tools or JSON.

Return ONLY a JSON object with exactly these keys:
{
 "assessment": {
   "status": "gathering"|"narrowed"|"probably_normal"|"needs_engineer"|"resolved",
   "candidates": [{"cause": string, "likelihood": "high"|"medium"|"low", "evidence": [fact ids]}],
   "confidence": "low"|"medium"|"high",
   "knowledgeIds": [knowledgeId strings you relied on],
   "summary": short customer-facing name of the most likely cause (or "Probably normal"), or null while gathering
 },
 "next": {"key": snake_case id of the question/check you are asking for, "question": the question text} or null,
 "reply": the message to the customer
}`;

// Structured output: a JSON schema (LM Studio and OpenAI both accept `json_schema`; LM Studio rejects `json_object`).
const str = { type: 'string' };
const nstr = { type: ['string', 'null'] };
// Strict structured output (OpenAI strict mode needs additionalProperties: false on every object; LM Studio accepts it).
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    assessment: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['gathering', 'narrowed', 'probably_normal', 'needs_engineer', 'resolved'] },
        candidates: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { cause: str, likelihood: { type: 'string', enum: ['high', 'medium', 'low'] }, evidence: { type: 'array', items: str } }, required: ['cause', 'likelihood', 'evidence'] } },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        knowledgeIds: { type: 'array', items: str },
        summary: nstr,
      },
      required: ['status', 'candidates', 'confidence', 'knowledgeIds', 'summary'],
    },
    next: { type: ['object', 'null'], additionalProperties: false, properties: { key: str, question: str }, required: ['key', 'question'] },
    reply: str,
  },
  required: ['assessment', 'next', 'reply'],
};
const RESPONSE_FORMAT = { type: 'json_schema', json_schema: { name: 'ac2_turn', strict: true, schema: SCHEMA } };

function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function parseJson(text) {
  const t = stripThinking(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

function conversationFor(messages) {
  return messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'customer', text: typeof m.content === 'string' ? m.content : textOf(m.content) }));
}
function textOf(content) {
  if (!Array.isArray(content)) return String(content || '');
  return content.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ') + (content.some((p) => p && p.type === 'image_url') ? ' [photo attached]' : '');
}

/**
 * One reasoning pass. Returns { proposal, usage, ms, raw }.
 * Throws InferenceError (provider failure) or ReasonerError (unusable output after one retry).
 */
async function reason(provider, context, { maxTokens = 1800, temperature = 0.3, timeoutMs = 60000, feedback = null } = {}) {
  const user = {
    turn: context.turn,
    conversation: conversationFor(context.messages),
    ledger: context.ledger,
    tools: context.tools,
    knowledge: context.knowledge,
    normalBehaviour: context.normal,
    safety: context.safety,
    plan: context.plan || [],
    ...(feedback ? { correctionFromSystem: feedback } : {}),
  };
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(user) }];
  const t0 = Date.now();
  let res = await provider.infer({ messages, maxTokens, temperature, timeoutMs, responseFormat: RESPONSE_FORMAT, stream: false });
  let proposal = res.status === 200 ? parseJson(res.text) : null;
  let usage = res.usage || null;
  let attempts = 1;
  if (!valid(proposal)) {
    // One retry without the response_format hint (some local servers reject it) and a stricter reminder.
    attempts = 2;
    messages.push({ role: 'user', content: 'Return only the JSON object described, nothing else.' });
    res = await provider.infer({ messages, maxTokens, temperature: 0.2, timeoutMs, stream: false });
    proposal = res.status === 200 ? parseJson(res.text) : null;
    usage = sumUsage(usage, res.usage);
  }
  const ms = Date.now() - t0;
  if (!valid(proposal)) {
    const err = new Error(`reasoner returned unusable output (status ${res.status})`);
    err.name = 'ReasonerError';
    err.category = res.status === 200 ? 'MALFORMED' : 'HTTP';
    err.status = res.status;
    err.detail = res.errorDetail || (res.status === 200 ? String(res.text || '').slice(0, 200) : null);
    throw err;
  }
  return { proposal: normalise(proposal), usage, ms, attempts };
}

function valid(p) {
  return Boolean(p && typeof p === 'object' && typeof p.reply === 'string' && p.reply.trim());
}

function sumUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const out = { ...a };
  for (const k of Object.keys(b)) if (typeof b[k] === 'number') out[k] = (out[k] || 0) + b[k];
  return out;
}

const arr = (x) => (Array.isArray(x) ? x : []);
function normalise(p) {
  const a = p.assessment && typeof p.assessment === 'object' ? p.assessment : {};
  return {
    assessment: {
      status: ['gathering', 'narrowed', 'probably_normal', 'needs_engineer', 'resolved'].includes(a.status) ? a.status : 'gathering',
      candidates: arr(a.candidates).filter((c) => c && c.cause).slice(0, 5).map((c) => ({ cause: String(c.cause).slice(0, 120), likelihood: ['high', 'medium', 'low'].includes(c.likelihood) ? c.likelihood : 'low', evidence: arr(c.evidence).map(String).slice(0, 8) })),
      confidence: ['low', 'medium', 'high'].includes(a.confidence) ? a.confidence : 'low',
      knowledgeIds: arr(a.knowledgeIds).map(String).slice(0, 4),
      summary: typeof a.summary === 'string' && a.summary.trim() ? a.summary.slice(0, 120) : null,
    },
    next: p.next && typeof p.next === 'object' && p.next.question ? { key: String(p.next.key || '').slice(0, 60), question: String(p.next.question).slice(0, 300) } : null,
    reply: stripThinking(p.reply).slice(0, 2400),
  };
}

module.exports = { reason, parseJson, SYSTEM, APPLIANCE_ENUM, stripThinking, textOf, RESPONSE_FORMAT };
