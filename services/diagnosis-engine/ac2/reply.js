'use strict';
/**
 * Step 8: Qwen writes the reply as a normal chat. The whole conversation goes in as real user / assistant turns; the
 * briefing (what we know, what our tools found, safety notes) goes in the system message. The plan for this turn is
 * also attached to the latest customer message as a marked note, so it is the last thing Qwen reads: with the plan only
 * at the top of a long system message, a small model sometimes copied its own previous reply from the history.
 * Plain text out: no form to fill in.
 */
const { textOf, stripThinking, ProviderUnavailableError } = require('./util.js');

const REPLY_SYSTEM = `You are Appliance Clinic, a friendly, expert UK home-appliance repair advisor chatting with a homeowner. You talk like a good engineer on the phone: practical, clear and honest.

Write your next reply to the customer:
- If they asked a question, answer it first.
- Follow PLAN FOR THIS REPLY in the briefing.
- Use the briefing's knowledge (likely causes, owner-safe checks, error-code meanings, normal behaviour) and your own expertise.
- Give at most one or two checks at a time, as short clear steps, including how to make it safe (switched off and unplugged, towels for water, let it cool).
- Never ask for anything listed under ALREADY KNOWN. Never repeat a question the customer could not or would not answer.
- ALREADY KNOWN.customerSaid and checksDone are what the customer told you: treat them as true, never contradict them and never ask about them again.
- Only state things about their appliance that the customer told you or the briefing gives. Never describe a symptom, result or state they have not reported (if they said it pulses, do not say it is dead), and never say they did a check unless checksDone lists it. Do not assume a design or feature of their model they have not told you (frost-free, induction, heat pump, double oven, its age or how much it is used). Do not invent part numbers, prices or model details.
- Be honest about certainty: talk about causes as possibilities ("often", "the most common cause is", "it could be") until a check result proves one. Never say "confirms", "definitely" or "this is" about a cause the checks have not proved.
- Never suggest anything unsafe: no testing with the power on, no opening a microwave casing, no gas or refrigerant work, no bypassing safety devices, no using an appliance that smelt of burning.
- 3 to 7 short sentences in plain text. No headings, no lists of more than 3 steps.`;

function briefing({ known, knowledge, codeMeanings, normal, plan, safetyNotes, recalls }) {
  const lines = ['', 'BRIEFING', `ALREADY KNOWN: ${JSON.stringify(known)}`];
  if (codeMeanings && codeMeanings.length) lines.push(`ERROR CODES (from the error-code catalogue): ${JSON.stringify(codeMeanings)}`);
  if (knowledge && knowledge.length) lines.push(`KNOWLEDGE (fault notes for this appliance and symptom): ${JSON.stringify(knowledge)}`);
  if (normal && normal.length) lines.push(`NORMAL BEHAVIOUR NOTES: ${JSON.stringify(normal)}`);
  if (recalls && recalls.length) lines.push(`PRODUCT RECALLS that may match: ${JSON.stringify(recalls)}`);
  if (safetyNotes && safetyNotes.length) lines.push(`SAFETY: ${safetyNotes.join(' ')}`);
  lines.push(`PLAN FOR THIS REPLY: ${plan.join(' ')}`);
  return lines.join('\n');
}

const NOTE = '[Note for the assistant, not from the customer] PLAN FOR THIS REPLY:';

function chatHistory(messages, plan = null) {
  const out = messages.slice(-16).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: textOf(m.content).slice(0, 2000) }));
  const last = out[out.length - 1];
  if (plan && plan.length && last && last.role === 'user') last.content = `${last.content}\n\n${NOTE} ${plan.join(' ')} Write a new reply that moves the conversation forward; do not reuse an earlier reply.`;
  return out;
}

async function writeReply(provider, { messages, brief }, { timeoutMs = 45000, temperature = 0.4 } = {}) {
  const system = REPLY_SYSTEM + briefing(brief);
  const t0 = Date.now();
  let res;
  try {
    res = await provider.infer({ messages: [{ role: 'system', content: system }, ...chatHistory(messages, brief.plan)], maxTokens: 600, temperature, timeoutMs, stream: false });
  } catch (e) {
    throw new ProviderUnavailableError('reply model unavailable', e);
  }
  const text = res && res.status === 200 ? stripThinking(res.text) : '';
  if (!text) throw new ProviderUnavailableError('reply model unavailable', { category: res && res.status === 200 ? 'EMPTY' : 'HTTP', status: res && res.status, detail: res && res.errorDetail });
  return { text, ms: Date.now() - t0, usage: res.usage || null };
}

module.exports = { writeReply, briefing, chatHistory, REPLY_SYSTEM, NOTE };
