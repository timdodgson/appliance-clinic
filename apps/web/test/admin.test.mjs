// Admin bootstrap and the read-only Knowledge page, against a stubbed /api. Authentication is the BFF's: the page
// asks /api/auth/me and signs in through /api/auth/login (AC Cognito behind the API); it holds no pool configuration.
import { describe, it, expect } from 'vitest';
import { loadPage, settle } from './harness.mjs';

const SCRIPTS = ['chat-session.js', 'tac-logic.js', 'tac-workbench.js', 'cts-logic.js', 'kn-logic.js', 'md-logic.js', 'dg-logic.js', 'ec-logic.js', 'st-logic.js', 'si-logic.js', 'admin.js'];
const ADMIN = { authenticated: true, user: { name: 'Test Admin', email: 'admin@example.invalid', isAdmin: true } };
const RECORD = {
  knowledgeId: 'washing-machine:not-draining', applianceFamily: 'washing-machine', faultId: 'not-draining', label: 'Not draining',
  symptoms: ['water left in the drum'], components: [], discriminators: [], relatedTopics: [], technical: {},
};

function admin(meBody, { hash = '', extra = () => null } = {}) {
  return loadPage('admin.html', SCRIPTS, (url, init) => {
    if (url.endsWith('/auth/me')) return { status: 200, body: meBody };
    if (url.endsWith('/auth/login')) return { status: 401, body: { error: 'Invalid email or password' } };
    const r = extra(url, init);
    if (r) return r;
    if (url.includes('/admin/dashboard')) return { status: 200, body: { period: '7d', totals: {} } };
    return { status: 200, body: {} };
  }, { hash });
}

describe('admin bootstrap', () => {
  it('signed out: the sign-in gate, no shell, no admin data requested', async () => {
    const a = admin({ authenticated: false });
    await settle(a.window);
    expect(a.document.getElementById('gate').hidden).toBe(false);
    expect(a.document.getElementById('shell').hidden).toBe(true);
    expect(a.calls.map((c) => c.url)).toEqual(['/api/auth/me']);
  });

  it('a signed-in customer without the admin group is told so and stays on the gate', async () => {
    const a = admin({ authenticated: true, user: { email: 'someone@example.invalid', isAdmin: false } });
    await settle(a.window);
    expect(a.document.getElementById('shell').hidden).toBe(true);
    expect(a.document.getElementById('gateSub').textContent).toMatch(/does not have admin access/);
  });

  it('sign-in posts to the AC API and shows its error', async () => {
    const a = admin({ authenticated: false });
    await settle(a.window);
    a.document.getElementById('gEmail').value = 'admin@example.invalid';
    a.document.getElementById('gPassword').value = 'wrong';
    a.document.getElementById('gateForm').dispatchEvent(new a.window.Event('submit', { cancelable: true }));
    await settle(a.window);
    const login = a.calls.find((c) => c.url === '/api/auth/login');
    expect(login.init.method).toBe('POST');
    expect(login.body).toEqual({ email: 'admin@example.invalid', password: 'wrong' });
    expect(a.document.getElementById('gError').textContent).toBe('Invalid email or password');
  });

  it('an admin session reveals the shell and loads the dashboard', async () => {
    const a = admin(ADMIN);
    await settle(a.window);
    expect(a.errors).toEqual([]);
    expect(a.document.getElementById('shell').hidden).toBe(false);
    expect(a.document.getElementById('userName').textContent).toBe('Test Admin');
    expect(a.calls.some((c) => c.url.startsWith('/api/admin/dashboard'))).toBe(true);
  });
});

describe('knowledge is read-only (ADR 0019)', () => {
  it('the record page offers no editing and calls no removed route', async () => {
    const a = admin(ADMIN, { hash: '#knowledge/washing-machine%3Anot-draining', extra: (url) => (url.includes('/admin/knowledge/record') ? { status: 200, body: RECORD } : null) });
    await settle(a.window, 12);
    expect(a.errors).toEqual([]);
    const detail = a.document.getElementById('knDetail');
    expect(detail.textContent).toMatch(/Not draining/);
    expect(detail.textContent).toMatch(/Read-only: knowledge records ship with the diagnosis engine/);
    expect(detail.querySelector('[data-kn-act]')).toBeNull();
    expect(a.document.getElementById('knNew')).toBeNull();
    const removed = /\/admin\/knowledge\/(draft|versions|validate|publish|rollback|restore|archive)/;
    expect(a.calls.filter((c) => removed.test(c.url))).toEqual([]);
  });
});

describe('transcript detail: AC2 decision panel', () => {
  const EVIL = '<img src=x onerror="window.__pwned=1">';
  const AC2 = {
    schemaVersion: 'ac2-transcript-audit/1', path: 'ac2', turn: 2,
    provider: { name: 'bedrock', model: 'test-model' }, timings: { reasonMs: 900, verifyMs: 120, totalMs: 1100 }, ms: 1300,
    toolCalls: [{ tool: 'error-codes', results: ['{"code":"F05","status":"RESOLVED"}'] }],
    safety: { hazards: ['electrical'], gates: [{ gate: 'prohibited-advice', rule: 'no-live-testing' }] },
    claimsRejected: [{ claim: 'The motor is burnt out', source: 'reply' }], claimsChecked: 3, regenerated: true,
    partGate: { outcome: 'model_needed', component: 'drain pump', failed: ['model_confirmed'], matcher: null, cited: ['f1'] },
    escalation: { to: 'electrician', reason: 'burning smell', forced: true },
    status: 'narrowing', appliance: 'washing-machine',
    candidates: [{ cause: 'Blocked pump filter', likelihood: 'high', evidence: ['f1', 'f2'] }],
    ledger: {
      appliance: { value: 'washing-machine', status: 'stated', turn: 1, quote: 'my washer' }, brand: null, model: null, codes: [], asked: [], hazards: ['electrical'],
      facts: [
        { id: 'f1', field: 'water_left_in_drum', value: true, source: 'customer', status: 'observed', turn: 1, quote: EVIL },
        { id: 'f2', field: 'pump_noise', value: 'none', source: 'customer', status: 'contradicted', turn: 2, quote: 'no hum at all' },
      ],
      factsTotal: 2,
    },
  };
  const DETAIL = {
    overview: { sessionId: 's-ac2-observe-01', lifecycle: 'active', canonical: { path: 'ac2', appliance: 'washing-machine', counts: { ac2: 1 }, ac2: { turns: 1, errors: 0, status: 'narrowing', partGate: 'model_needed', hazards: ['electrical'] } } },
    customerVisible: { turns: [{ seq: 1, at: '2026-10-12T10:00:00.000Z', customer: { text: 'it will not drain', photo: false }, applianceClinic: { reply: 'Check the filter.' }, canonical: null, ac2: AC2, runtime: { route: 'AC2', outcome: 'ANSWER' } }] },
    diagnosticMetadata: {},
  };

  it('renders the decision, ledger, contradictions, safety and part gate from turn.ac2, escaping customer quotes', async () => {
    const a = admin(ADMIN, { hash: '#transcripts/s-ac2-observe-01', extra: (url) => {
      if (url.includes('/admin/transcripts/session?')) return { status: 200, body: DETAIL };
      if (url.includes('/admin/transcripts')) return { status: 200, body: { items: [] } };
      return null;
    } });
    await settle(a.window, 16);
    expect(a.errors).toEqual([]);
    const detail = a.document.getElementById('txDetail');
    const panel = detail.querySelector('.tx-tp');
    expect(panel).not.toBeNull();
    const tabs = Array.from(panel.querySelectorAll('[data-tptab]')).map((b) => b.textContent);
    expect(tabs.slice(0, 4)).toEqual(['AC2 decision', 'Evidence ledger', 'Safety & verifier', 'Tool calls']);
    const text = panel.textContent;
    expect(panel.querySelector('.tx-tp__chips').textContent).toMatch(/AC2.*NARROWING.*HAZARD · electrical.*MODEL NEEDED.*1 CLAIM REJECTED.*REGENERATED.*ESCALATE · electrician/);
    expect(text).toMatch(/bedrock · test-model/);
    expect(text).toMatch(/reason 900 ms · verify 120 ms · total 1100 ms/);
    expect(text).toMatch(/Blocked pump filter/);
    expect(text).toMatch(/evidence f1, f2/);
    expect(text).toMatch(/model_confirmed/);
    expect(text).toMatch(/The motor is burnt out/);
    expect(text).toMatch(/prohibited-advice · no-live-testing/);
    expect(panel.querySelectorAll('.tx-ac2tbl tbody tr')).toHaveLength(2);
    expect(panel.querySelector('.tx-ac2tbl__bad').textContent).toMatch(/pump_noise/);
    // The malicious quote is shown as text, never parsed as markup.
    expect(panel.querySelector('img')).toBeNull();
    expect(text).toContain(EVIL);
    expect(a.window.__pwned).toBeUndefined();
    // Session header badges use the AC2 path.
    expect(detail.textContent).toMatch(/AC2/);
  });
});
