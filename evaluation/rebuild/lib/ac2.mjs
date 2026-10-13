// System A2: the ac2 engine (LLM-led diagnosis + guardrail kernel) on live production via the benchmark envelope with engine 'ac2'. Otherwise identical to independent-100/lib/ac.mjs.
// Original header:, POST https://applianceclinic.ai/api, exactly as the browser calls it:
// the same conversation window (the site's own chat-session.js), the opaque state token echoed back, one session.
// Transport: the service-authenticated benchmark envelope (the GOLD runner's), which is the same diagnose path but writes
// no customer transcript (so no transcript-review spend) and is not per-IP rate limited. It changes nothing in what AC
// decides or says. No admin, test or liveTest endpoint is used.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('../../../services/whichpart-api/index.js', import.meta.url)));
const benchmarkAuth = require('./benchmark-auth.js');
const Session = require('../../apps/web/public/chat-session.js');
const API = process.env.AC_API || 'https://applianceclinic.ai/api';
const rid = (n) => randomBytes(n).toString('hex');

let secrets = null;
export async function init() {
  secrets = await benchmarkAuth.loadSecrets();
  if (!secrets || !secrets.current) throw new Error('benchmark service secret unavailable');
}

/** One AC conversation. send(text) -> { view, status, ms } ; history mirrors the browser's `messages`. */
export function conversation(caseId) {
  const sessionId = `bm-ac2-${caseId.toLowerCase()}-${rid(5)}`;
  let stateToken = null; let n = 0; const history = [];
  async function post() {
    n += 1;
    const body = { messages: Session.buildApiMessages(history), engine: 'ac2', benchmark: { sessionId, clientTurnId: `bt-${n}-${rid(4)}` } };
    if (stateToken) body.stateToken = stateToken;
    const raw = JSON.stringify(body);
    const t0 = Date.now();
    const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json', [benchmarkAuth.HEADER]: benchmarkAuth.signRequest(secrets.current, raw) }, body: raw });
    const ms = Date.now() - t0;
    let view = null; try { view = await res.json(); } catch { view = null; }
    return { status: res.status, view, ms };
  }
  return {
    sessionId,
    async send(text) {
      history.push({ role: 'user', content: text });
      let r = await post();
      // the browser's retry button: one retry of the same turn after a short wait, as a customer would
      if (r.status >= 500 || r.status === 429 || r.status === 0) { await new Promise((x) => setTimeout(x, 6000)); r = await post(); r.retried = true; }
      if (r.status === 200 && r.view && r.view.reply) {
        if (typeof r.view.stateToken === 'string') stateToken = r.view.stateToken;
        history.push({ role: 'assistant', content: r.view.reply, media: Session.compactShownMedia(r.view.media), safetyInformation: Session.compactShownSafety(r.view.safetyInformation) });
      } else history.pop(); // the browser leaves the transcript unchanged on an error
      return r;
    },
  };
}

/** What the customer sees for an AC reply, as plain text (the same elements app.js renders). */
export function render({ status, view }) {
  if (status !== 200 || !view || !view.reply) return '[The page shows an error banner: "Couldn\'t reach the diagnosis service. Your conversation is unchanged." with a Retry button.]';
  const out = [];
  if (view.safety) out.push('⚠ Stop using this appliance');
  else if (view.advisory) out.push('Maintenance tip');
  else if (view.diagnosis && view.diagnosis.label) out.push(`[Heading: ${view.diagnosis.label}]`);
  out.push(view.reply);
  if (view.safetyInformation && view.safetyInformation.text) out.push(`[Safety panel] ${view.safetyInformation.text}`);
  if (Array.isArray(view.media) && view.media.length) {
    out.push(`[Helpful to see: ${view.media.slice(0, 4).map((m) => `${m.type === 'VIDEO' ? 'video' : 'image'} "${m.title || ''}"${m.caption || m.description ? ` — ${m.caption || m.description}` : ''}`).join('; ')}]`);
  }
  if (Array.isArray(view.parts) && view.parts.length) {
    out.push(view.parts.length > 1 ? '[Likely components involved]' : '[Likely component involved]');
    for (const p of view.parts) {
      const o = (p.offers && p.offers[0]) || {};
      const price = typeof o.price === 'number' ? ` — £${(o.price / 100).toFixed(2)}` : '';
      const fit = p.fitStatus === 'MODEL_CONFIRMED' ? 'Confirmed fit for your model' : 'Likely fit — please check';
      out.push(`[Part card: ${p.name || 'Part'}${price} — ${fit}${o.url ? ` — link "View at ${o.retailer || 'retailer'}"` : ''}]`);
    }
  } else if (view.needsModel && !view.extractedModel) {
    out.push('[Panel: "To check a suitable replacement — Enter your model number below. Once we have the model I can check whether a suitable replacement is available. It\'s usually on a sticker inside the door or around the frame, or on the back of the appliance."]');
  }
  return out.join('\n');
}
