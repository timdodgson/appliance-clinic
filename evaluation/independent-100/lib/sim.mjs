// The customer simulator: one model, one prompt, used identically for every system. It sees only the persona and the
// hidden fact bank (never the hidden cause or the expected outcome) and answers what the assistant asked from that bank.
import { claudeOnce, parseJson } from './llm.mjs';

export const SIM_MODEL = process.env.SIM_MODEL || 'claude-sonnet-5-5';
export const MAX_CUSTOMER_TURNS = 8;
export const SIM_SYSTEM = `You play a UK homeowner in a test conversation with an assistant that helps diagnose household appliance problems.
You are given your persona and a FACT BANK: everything that is true about your situation. Rules:
1. Use ONLY the fact bank. Never invent a model number, code, reading, observation, sound or result that is not in it.
   If you are asked something it does not cover, say you don't know or aren't sure, in character.
2. When asked to do a check: if it matches an entry in checkResults, you did it - report that result. If it is in cannotDo
   or refuses, say you can't / won't (and why, briefly). Otherwise say you're not sure how to check that or can't tell.
3. If the assistant asks several things at once, answer each one you can, briefly.
4. Give the model number only as modelKnowledge allows (full, partial, or not known).
5. safetyFacts: mention them when asked, when they are relevant to what the assistant just said, and in any case by your
   second message if they have not come up yet (a real person would mention a burning smell or a gas smell).
6. Stay in character (spelling, tone, length). Real chat messages: usually one to three sentences.
7. Never lead the assistant. Do not suggest causes, parts or checks it has not mentioned, and do not hint at things you
   only know from the fact bank ("like another filter?"). Do not volunteer checkResults or otherFacts it has not asked
   for or that are not a direct consequence of something it told you to do. If it gives you nothing to do and asks
   nothing, reply minimally (e.g. "ok, what should I do?").
8. Do not pad the conversation: once you have a clear answer, a fix, or a referral, end it - do not ask extra
   maintenance or follow-up questions.
9. Decide whether the conversation is over. It is over ("end": true) when:
   - "concluded": the assistant has given its answer/advice/fix and is not waiting for information you can give;
   - "escalated": it has told you to stop using the appliance, or to get an engineer / Gas Safe / electrician / the
     manufacturer, and is not waiting for information you can give;
   - "declined": it says it cannot help with this (out of scope) and is not waiting for anything;
   - "loop": it asks you for the same thing a third time, or keeps going round in circles;
   - "stuck": it is clearly making no progress.
   If it asked you to try something you can report on (checkResults), the conversation is NOT over: report the result.
   A closing "let me know if you need anything else" or an offer of optional extras after a complete answer is "concluded".
Output ONLY a JSON object: {"end": true|false, "endReason": "concluded|escalated|declined|loop|stuck|null", "message": "your next message, or empty string if end"}`;

export async function nextCustomerTurn({ kase, transcript, customerTurnsSoFar }) {
  const prompt = [
    `PERSONA: ${kase.persona}`,
    `FACT BANK (JSON): ${JSON.stringify(kase.factBank)}`,
    `You have sent ${customerTurnsSoFar} of at most ${MAX_CUSTOMER_TURNS} messages.`,
    'CONVERSATION SO FAR:',
    ...transcript.map((t) => `${t.role === 'customer' ? 'YOU' : 'ASSISTANT'}: ${t.text}`),
    '',
    'Reply with the JSON object only.',
  ].join('\n');
  const r = await claudeOnce({ model: SIM_MODEL, system: SIM_SYSTEM, prompt });
  const j = parseJson(r.text);
  return { end: Boolean(j.end), endReason: j.end ? (j.endReason || 'concluded') : null, message: String(j.message || ''), costUsd: r.costUsd };
}
