'use strict';
/**
 * Step 2: Qwen reads the latest customer message (with the last assistant message for context) and pulls out what it
 * means. Small, single job; the output is hints for Jev's labels, never written to the record directly.
 */
const { parseJson, ProviderUnavailableError, clean } = require('./util.js');

const UNDERSTAND_SYSTEM = `You read one message from a customer chatting with a UK home-appliance repair service and pull out what it says. Use the assistant's previous message only to understand what the customer is replying to. Extract only what the customer said or clearly meant; never guess. Use null or [] when something is not in the message.
- appliance: the appliance in plain words (e.g. "washing machine", "cordless vacuum"), also when only implied (Dyson -> vacuum).
- brand, model: as the customer wrote them. A series name like "V6" or "Series 6" counts as the model.
- codes: error codes shown on the display or by flashing lights, exactly as written.
- symptom: the fault in a few plain words.
- customerQuestion: a question the customer asked, if any.
- answerToLastQuestion: their answer to the assistant's last question, in a few words, if they answered it.
- checksReported: checks or fixes they say they did, each with what happened.
- cannotReachModel: true only if they say they cannot find, reach or read the model number right now.`;

const UNDERSTAND_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'ac3_understand',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['appliance', 'brand', 'model', 'codes', 'symptom', 'customerQuestion', 'answerToLastQuestion', 'checksReported', 'cannotReachModel'],
      properties: {
        appliance: { type: ['string', 'null'] },
        brand: { type: ['string', 'null'] },
        model: { type: ['string', 'null'] },
        codes: { type: 'array', items: { type: 'string' } },
        symptom: { type: ['string', 'null'] },
        customerQuestion: { type: ['string', 'null'] },
        answerToLastQuestion: { type: ['string', 'null'] },
        checksReported: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['check', 'result'], properties: { check: { type: 'string' }, result: { type: 'string' } } } },
        cannotReachModel: { type: 'boolean' },
      },
    },
  },
};

function normalise(j) {
  const o = j && typeof j === 'object' ? j : {};
  return {
    appliance: clean(o.appliance, 60),
    brand: clean(o.brand, 40),
    model: clean(o.model, 40),
    codes: Array.isArray(o.codes) ? o.codes.map((c) => clean(c, 16)).filter(Boolean).slice(0, 4) : [],
    symptom: clean(o.symptom, 160),
    customerQuestion: clean(o.customerQuestion, 200),
    answerToLastQuestion: clean(o.answerToLastQuestion, 160),
    checksReported: Array.isArray(o.checksReported) ? o.checksReported.filter((c) => c && clean(c.check)).map((c) => ({ check: clean(c.check, 120), result: clean(c.result, 160) || '' })).slice(0, 4) : [],
    cannotReachModel: o.cannotReachModel === true,
  };
}

async function understand(provider, { latest, priorAssistant }, { timeoutMs = 30000 } = {}) {
  const user = JSON.stringify({ assistantPreviousMessage: priorAssistant || null, customerMessage: latest });
  const t0 = Date.now();
  let res;
  try {
    res = await provider.infer({ messages: [{ role: 'system', content: UNDERSTAND_SYSTEM }, { role: 'user', content: user }], maxTokens: 400, temperature: 0, timeoutMs, responseFormat: UNDERSTAND_FORMAT, stream: false });
  } catch (e) {
    throw new ProviderUnavailableError('understanding model unavailable', e);
  }
  const json = res && res.status === 200 ? parseJson(res.text) : null;
  if (!json) throw new ProviderUnavailableError('understanding model unavailable', { category: res && res.status === 200 ? 'MALFORMED' : 'HTTP', status: res && res.status, detail: res && res.errorDetail });
  return { reading: normalise(json), ms: Date.now() - t0, usage: res.usage || null };
}

module.exports = { understand, normalise, UNDERSTAND_SYSTEM, UNDERSTAND_FORMAT };
