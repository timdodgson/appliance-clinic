// Customer chat (index.html + chat-session.js + app.js) against a stubbed /api: what the customer sees for each kind
// of BFF view, and what the client sends.
import { describe, it, expect } from 'vitest';
import { loadPage, settle } from './harness.mjs';

const SCRIPTS = ['chat-session.js', 'app.js'];
const me = { status: 200, body: { authenticated: false } };

async function send(text, view, { status = 200 } = {}) {
  const page = loadPage('index.html', SCRIPTS, (url, init) => {
    if (url.endsWith('/auth/me')) return me;
    if (url === '/api' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.observability && body.observability.event === 'end') return { status: 200, body: {} };
      if (view instanceof Error) throw view;
      return { status, body: view };
    }
    return { status: 404, body: {} };
  });
  await settle(page.window);
  const input = page.document.getElementById('input');
  input.value = text;
  page.document.getElementById('ask').dispatchEvent(new page.window.Event('submit', { cancelable: true }));
  await settle(page.window);
  const turns = page.document.querySelectorAll('#thread .turn--bot');
  return { ...page, bot: turns[turns.length - 1] || null, diagnosisCalls: page.calls.filter((c) => c.url === '/api' && c.body && c.body.messages) };
}

describe('customer chat', () => {
  it('sends the conversation to the same-origin AC API only, and renders the reply verbatim (text, never HTML)', async () => {
    const reply = 'Let’s narrow it down. Is the drum full of water? <b>not bold</b>';
    const r = await send('my washing machine will not drain', { reply, stateToken: 'cst1.test' });
    expect(r.errors).toEqual([]);
    expect(r.diagnosisCalls).toHaveLength(1);
    expect(r.diagnosisCalls[0].body.messages.at(-1)).toMatchObject({ role: 'user', content: 'my washing machine will not drain' });
    expect(r.calls.every((c) => c.url.startsWith('/api'))).toBe(true);
    expect(r.bot.querySelector('.response__lead').textContent).toBe(reply);
    expect(r.bot.querySelector('b')).toBeNull();
  });

  it('bot check: a Turnstile token on the first message of a conversation only (change 21.38)', async () => {
    const page = loadPage('index.html', SCRIPTS, (url) => {
      if (url.endsWith('/auth/me')) return me;
      return { status: 200, body: { reply: 'Was the clock flashing?', stateToken: 'cst1.opaque.token' } };
    });
    let n = 0;
    page.window.turnstile = { render: (box, o) => { page.window._cb = o.callback; return 'w1'; }, reset() {}, execute() { n += 1; page.window._cb(`ts-token-${n}`); } };
    await settle(page.window);
    for (const text of ['oven not heating', 'no']) {
      page.document.getElementById('input').value = text;
      page.document.getElementById('ask').dispatchEvent(new page.window.Event('submit', { cancelable: true }));
      await settle(page.window);
    }
    const calls = page.calls.filter((c) => c.url === '/api' && c.body && c.body.messages);
    expect(calls).toHaveLength(2);
    expect(calls[0].body.turnstile).toBe('ts-token-1');
    expect(calls[1].body.turnstile).toBeUndefined();
    expect(calls[1].body.stateToken).toBe('cst1.opaque.token');
  });

  it('bot check: an expired conversation (API 428) is retried once with a Turnstile token', async () => {
    let n = 0;
    const page = loadPage('index.html', SCRIPTS, (url, init) => {
      if (url.endsWith('/auth/me')) return me;
      const body = JSON.parse(init.body);
      n += 1;
      if (n === 1) return { status: 200, body: { reply: 'Was the clock flashing?', stateToken: 'cst1.old' } };
      if (!body.turnstile) return { status: 428, body: { code: 'bot_check_failed' } };
      return { status: 200, body: { reply: 'Set the clock then.', stateToken: 'cst1.new' } };
    });
    let k = 0;
    page.window.turnstile = { render: (box, o) => { page.window._cb = o.callback; return 'w1'; }, reset() {}, execute() { k += 1; page.window._cb(`ts-${k}`); } };
    await settle(page.window);
    for (const text of ['oven not heating', 'no']) {
      page.document.getElementById('input').value = text;
      page.document.getElementById('ask').dispatchEvent(new page.window.Event('submit', { cancelable: true }));
      await settle(page.window, 16);
    }
    const calls = page.calls.filter((c) => c.url === '/api' && c.body && c.body.messages);
    expect(calls).toHaveLength(3);
    expect(calls[1].body.turnstile).toBeUndefined();
    expect(calls[2].body.turnstile).toBe('ts-2');
    expect(page.document.querySelector('#thread .turn--bot:last-child .response__lead').textContent).toBe('Set the clock then.');
  });

  it('echoes the state token on the next turn, unopened', async () => {
    const r = await send('oven not heating', { reply: 'Was the clock flashing?', stateToken: 'cst1.opaque.token' });
    r.document.getElementById('input').value = 'no';
    r.document.getElementById('ask').dispatchEvent(new r.window.Event('submit', { cancelable: true }));
    await settle(r.window);
    const calls = r.calls.filter((c) => c.url === '/api' && c.body && c.body.messages);
    expect(calls).toHaveLength(2);
    expect(calls[0].body.stateToken).toBeUndefined();
    expect(calls[1].body.stateToken).toBe('cst1.opaque.token');
    expect(calls[1].body.observability).toMatchObject({ event: 'turn' });
  });

  it('an API error keeps the transcript and shows the retry banner, with no invented assistant turn', async () => {
    const r = await send('fridge not cold', { error: 'unavailable' }, { status: 503 });
    expect(r.bot).toBeNull();
    const status = r.document.getElementById('askStatus');
    expect(status.hidden).toBe(false);
    expect(r.document.getElementById('askStatusText').textContent).toMatch(/Couldn.t reach the diagnosis service/);
    expect(r.document.getElementById('retryBtn').hidden).toBe(false);
    expect(r.document.querySelectorAll('#thread .turn--user')).toHaveLength(1);
  });

  it('a network failure shows the same banner (offline wording when the browser is offline)', async () => {
    const r = await send('dryer not heating', new TypeError('Failed to fetch'));
    expect(r.bot).toBeNull();
    expect(r.document.getElementById('askStatus').hidden).toBe(false);
  });

  it('a safety stop is presented from the structured flag, with its heading', async () => {
    const r = await send('I can smell gas from the hob', { reply: 'Turn off the gas at the meter and open the windows. Call the Gas Emergency line on 0800 111 999.', safety: true });
    expect(r.bot.classList.contains('turn--safety-stop')).toBe(true);
    expect(r.bot.querySelector('.safety-info__title').textContent).toBe('Stop using this appliance');
    expect(r.bot.querySelector('.response__lead').textContent).toMatch(/0800 111 999/);
  });

  it('safety information on an ordinary reply is its own panel, verbatim', async () => {
    const r = await send('microwave sparking', { reply: 'Stop using it for now.', safetyInformation: { classification: 'DO_NOT_OPEN', text: 'Never open the casing: high voltage inside.' } });
    const panel = r.bot.querySelector('.safety-info--do-not-open');
    expect(panel.querySelector('.safety-info__title').textContent).toBe('Do not open this appliance');
    expect(panel.querySelector('.safety-info__text').textContent).toBe('Never open the casing: high voltage inside.');
  });

  it('a diagnosis shows its summary as the lead, then the rest of the reply, with no label overline', async () => {
    const summary = 'The pump filter is the most likely cause.';
    const r = await send('not draining', { reply: `${summary} Clear it with the machine unplugged.`, diagnosis: { summary } });
    expect(r.bot.querySelector('.response__diag')).toBeNull();
    expect(r.bot.querySelector('.response__lead').textContent).toBe(summary);
    expect(r.bot.querySelector('.response__body').textContent).toBe('Clear it with the machine unplugged.');
  });

  it('media: an image opens larger, a video embeds only privacy-enhanced YouTube', async () => {
    const r = await send('where is the filter', { reply: 'It is behind the flap.', media: [
      { type: 'IMAGE', title: 'Pump filter location', url: '/media/filter.jpg', alt: 'Filter flap' },
      { type: 'VIDEO', title: 'Clearing the filter', embedUrl: 'https://www.youtube-nocookie.com/embed/abc123' },
      { type: 'VIDEO', title: 'Untrusted', embedUrl: 'https://evil.example/embed/x' },
    ] });
    const imgs = r.bot.querySelectorAll('.media__img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe('/media/filter.jpg');
    const frames = [...r.bot.querySelectorAll('iframe')].map((f) => f.getAttribute('src'));
    expect(frames).toEqual(['https://www.youtube-nocookie.com/embed/abc123']);
  });

  it('a part card shows the fit badge and links out to the shop URL the API returned (new tab, no referrer)', async () => {
    const r = await send('ZWF81463W not draining', { reply: 'The drain pump has failed.', parts: [
      { name: 'Drain pump', fitStatus: 'MODEL_CONFIRMED', offers: [{ price: 2899, currency: 'GBP', url: 'https://www.spares4repairs.example/p/123', retailer: 'Spares4Repairs' }] },
    ] });
    const card = r.bot.querySelector('.part');
    expect(card.querySelector('.part__name').textContent).toBe('Drain pump');
    expect(card.querySelector('.fit--confirmed').textContent).toBe('Confirmed fit for your model');
    expect(card.querySelector('.part__price').textContent).toMatch(/£28\.99/);
    const a = card.querySelector('a.part__cta');
    expect(a.getAttribute('href')).toBe('https://www.spares4repairs.example/p/123');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('a reply that asks for the model is shown as the advisor wrote it, with no part and no extra prompt', async () => {
    const r = await send('dishwasher not filling', { reply: 'Could you send me the model number?', parts: [] });
    expect(r.bot.querySelector('.response__lead').textContent).toBe('Could you send me the model number?');
    expect(r.bot.querySelector('.model-req')).toBeNull();
    expect(r.bot.querySelector('.part')).toBeNull();
  });

  it('typing saves the draft without a script error (the live site threw on every keystroke)', async () => {
    const r = await send('x', { reply: 'ok' });
    const input = r.document.getElementById('input');
    input.value = 'half-typed message';
    input.dispatchEvent(new r.window.Event('input'));
    await new Promise((res) => r.window.setTimeout(res, 350));
    expect(r.errors).toEqual([]);
    const saved = JSON.parse(r.window.localStorage.getItem('ac.chat.session.v1') || r.window.localStorage.getItem(Object.keys(r.window.localStorage)[0]) || '{}');
    expect(saved.draft).toBe('half-typed message');
  });
});
