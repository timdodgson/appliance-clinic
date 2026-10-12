// System B: a strong general-purpose AI assistant used as a normal person would use it: a fresh chat, a generic
// assistant system prompt (no appliance instructions, no knowledge of the benchmark), the customer's own messages.
import { randomUUID } from 'node:crypto';
import { claude } from './llm.mjs';

export const GA_MODEL = process.env.GA_MODEL || 'claude-opus-5-5';
export const GA_SYSTEM = 'You are Claude, a helpful AI assistant made by Anthropic. The current date is Monday 12 October 2026.';

export function conversation() {
  const sessionId = randomUUID(); let started = false;
  return {
    sessionId,
    async send(text) {
      const t0 = Date.now();
      try {
        const r = await claude({ model: GA_MODEL, system: GA_SYSTEM, prompt: text, sessionId, resume: started, persist: true });
        started = true;
        return { status: 200, text: r.text, ms: Date.now() - t0, costUsd: r.costUsd };
      } catch (e) {
        return { status: 0, text: '', ms: Date.now() - t0, error: String(e.message).slice(0, 300) };
      }
    },
  };
}
export const render = (r) => (r.status === 200 && r.text ? r.text : '[The assistant failed to respond.]');
