'use strict';
/**
 * Step 8: Qwen writes the reply as a normal chat. The whole conversation goes in as real user / assistant turns; the
 * briefing (what we know, what our tools found, the plan for this turn, safety notes) goes in the system message.
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
- Only state things about their appliance that the customer told you or the briefing gives. Never describe a symptom, result or state they have not reported (if they said it pulses, do not say it is dead). Do not invent part numbers, prices or model details.
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

function chatHistory(messages) {
  return messages.slice(-16).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: textOf(m.content).slice(0, 2000) }));
}

async function writeReply(provider, { messages, brief }, { timeoutMs = 45000 } = {}) {
  const system = REPLY_SYSTEM + briefing(brief);
  const t0 = Date.now();
  let res;
  try {
    res = await provider.infer({ messages: [{ role: 'system', content: system }, ...chatHistory(messages)], maxTokens: 600, temperature: 0.4, timeoutMs, stream: false });
  } catch (e) {
    throw new ProviderUnavailableError('reply model unavailable', e);
  }
  const text = res && res.status === 200 ? stripThinking(res.text) : '';
  if (!text) throw new ProviderUnavailableError('reply model unavailable', { category: res && res.status === 200 ? 'EMPTY' : 'HTTP', status: res && res.status, detail: res && res.errorDetail });
  return { text, ms: Date.now() - t0, usage: res.usage || null };
}

module.exports = { writeReply, briefing, chatHistory, REPLY_SYSTEM };
