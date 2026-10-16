// Admin bootstrap and the read-only Knowledge page, against a stubbed /api. Authentication is the BFF's: the page
// asks /api/auth/me and signs in through /api/auth/login (AC Cognito behind the API); it holds no pool configuration.
import { describe, it, expect } from 'vitest';
import { loadPage, settle } from './harness.mjs';

const SCRIPTS = ['chat-session.js', 'tac-workbench.js', 'kn-logic.js', 'md-logic.js', 'dg-logic.js', 'ec-logic.js', 'st-logic.js', 'si-logic.js', 'admin.js'];
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
    if (url.includes('/admin/dashboard')) return { status: 200, body: { ok: true, health: { ok: true, label: 'Healthy', summaryLine: 'API · Diagnosis engine · Error codes', failed: [] }, activity: { sessionsToday: 0 }, state: { diagnosis: { architecture: 'ac2' } } } };
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

  it("today's activity lists the appliance families from the server's [{family, count}] distribution", async () => {
    const activity = { generatedAt: '2026-10-16T14:00:00.000Z', sessionsToday: 3, turnsToday: 7, partSessionsToday: 1, safetySessionsToday: 0, errorSessionsToday: 0,
      familyDistribution: [{ family: 'washing-machine', count: 2 }, { family: 'vacuum', count: 1 }] };
    const a = admin(ADMIN, { extra: (url) => (url.includes('/admin/dashboard')
      ? { status: 200, body: { ok: true, health: { ok: true, label: 'Healthy', summaryLine: 'API', failed: [] }, activity, state: { diagnosis: { architecture: 'ac2' } } } } : null) });
    await settle(a.window);
    expect(a.errors).toEqual([]);
    const body = a.document.getElementById('dashActivityBody');
    expect(body.textContent).toMatch(/Washing machine/);
    expect(body.textContent).toMatch(/Vacuum/);
    expect(body.textContent).not.toMatch(/object Object/);
    const links = [...body.querySelectorAll('a')].map((el) => el.getAttribute('href'));
    expect(links.some((h) => /family=washing-machine/.test(h))).toBe(true);
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
    schemaVersion: 'ac2-transcript-audit/2', path: 'ac2', turn: 2,
    provider: { name: 'anthropic', model: 'test-model' }, timings: { adviseMs: 900, totalMs: 1100 }, ms: 1300,
    usage: { inputTokens: 1200, outputTokens: 300 },
    toolCalls: ['lookup_error_code', 'find_parts', 'send_reply'],
    safety: { hazards: ['electrical'], gates: [{ gate: 'prohibited-advice', rule: 'no-live-testing' }] },
    partGate: { outcome: 'model_needed', component: 'drain pump', reason: null },
    escalation: { to: 'electrician', reason: 'burning smell', forced: true },
    outcome: 'diagnosing',
    customer: { appliance: 'washing-machine', brand: 'Hotpoint', model: EVIL },
    hazards: ['electrical'],
    tags: { outcome: 'diagnosing', media: null, enrichment: { knowledgeIds: ['washing-machine:not-draining'], codes: [{ code: 'F05', status: 'RESOLVED' }], recalls: 0, parts: 0 } },
  };
  const DETAIL = {
    overview: { sessionId: 's-ac2-observe-01', lifecycle: 'active', family: 'washing-machine', make: 'Hotpoint', partRecommended: false,
      ac2: { turns: 1, errors: 0, outcome: 'diagnosing', hazards: ['electrical'], partRecommended: false, escalation: 'electrician', appliance: 'washing-machine' } },
    customerVisible: { turns: [{ seq: 1, at: '2026-10-12T10:00:00.000Z', customer: { text: 'it will not drain', photo: false }, applianceClinic: { reply: 'Check the filter.' }, ac2: AC2, runtime: { route: 'AC2', outcome: 'ANSWER' } }] },
    diagnosticMetadata: { family: 'washing-machine', make: 'Hotpoint' },
  };

  it('renders the decision, safety, tools and enrichment from turn.ac2, escaping customer values', async () => {
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
    expect(tabs).toEqual(['AC2 decision', 'Safety', 'Tools & enrichment', 'Runtime']);
    const text = panel.textContent;
    expect(panel.querySelector('.tx-tp__chips').textContent).toMatch(/AC2.*DIAGNOSING.*HAZARD · electrical.*MODEL NEEDED.*ESCALATE · electrician/);
    expect(text).toMatch(/anthropic · test-model/);
    expect(text).toMatch(/advise 900 ms · total 1100 ms/);
    expect(text).toMatch(/inputTokens 1200 · outputTokens 300/);
    expect(text).toMatch(/lookup_error_code/);
    expect(text).toMatch(/F05 \(RESOLVED\)/);
    expect(text).toMatch(/washing-machine:not-draining/);
    expect(text).toMatch(/prohibited-advice · no-live-testing/);
    expect(text).toMatch(/burning smell/);
    // The malicious value is shown as text, never parsed as markup.
    expect(panel.querySelector('img')).toBeNull();
    expect(text).toContain(EVIL);
    expect(a.window.__pwned).toBeUndefined();
    // Session header badges use the AC2 vocabulary; no review or canonical layer exists.
    expect(detail.querySelector('.tx-detailmeta').textContent).toMatch(/AC2.*DIAGNOSING.*HAZARD · electrical.*ESCALATE · electrician/);
    expect(Array.from(detail.querySelectorAll('.tx-tab')).map((b) => b.textContent)).toEqual(['Conversation', 'Technical']);
    expect(a.calls.filter((c) => /review|quality|benchmark|library/.test(c.url))).toEqual([]);
  });
});

describe('conversations list: stored facts only', () => {
  it('quick views and filters are the stored facts the API accepts; rows carry no review wording', async () => {
    const ROW = { sessionId: 'client-detail-0001', shortId: 'client-d', createdAt: '2026-10-12T10:00:00.000Z', lastActivityAt: '2026-10-12T10:05:00.000Z', lifecycle: 'active', turnCount: 2,
      family: 'washing machine', make: 'hotpoint', outcome: 'ANSWER', safetyStop: false, hasError: false, partRecommended: true, openingPreview: 'my hotpoint washing machine will not drain',
      ac2: { turns: 2, errors: 0, outcome: 'part_needed', hazards: [], partRecommended: true, escalation: null, appliance: 'washing machine' } };
    const a = admin(ADMIN, { hash: '#transcripts?partRecommended=1', extra: (url) => (url.includes('/admin/transcripts?') ? { status: 200, body: { items: [ROW], viewCounts: { all: 3, safety: 1, errors: 0, parts: 1 }, retention: { retentionDays: 90 } } } : null) });
    await settle(a.window, 12);
    expect(a.errors).toEqual([]);
    const list = a.calls.find((c) => c.url.includes('/admin/transcripts?'));
    expect(list.url).toContain('partRecommended=1');
    expect(list.url).not.toMatch(/attention|reviewStatus|canonical|journey|route=/);
    expect(Array.from(a.document.querySelectorAll('.tx-view')).map((b) => b.getAttribute('data-view'))).toEqual(['all', 'safety', 'errors', 'parts']);
    expect(a.document.getElementById('txViewParts').getAttribute('aria-checked')).toBe('true');
    expect(a.document.getElementById('txCountParts').textContent).toBe('1');
    const row = a.document.querySelector('.tx-row');
    expect(row.querySelector('.tx-row__flags').textContent).toMatch(/Part needed.*Part recommended/);
    expect(a.document.querySelector('.tx-list').textContent).not.toMatch(/Needs attention|Review|Loop/);
    for (const id of ['txReviewStatus', 'txRoute', 'txJourney', 'txCanonical', 'txOverall', 'txAttention']) expect(a.document.getElementById(id)).toBeNull();
  });
});

describe('settings: the advisor model is the one editable setting', () => {
  const VIEW = {
    purpose: 'x',
    advisor: { editable: true, source: 'Admin runtime configuration', store: { status: 'ok', note: null }, version: 3, revision: '0123456789abcdef', updatedAt: null, updatedByEmail: null, history: [],
      configured: { provider: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-opus-5-5', modelLabel: 'claude-opus-5-5', credentialConfigured: true },
      running: { available: true, provider: 'anthropic', providerLabel: 'Anthropic (Claude)', model: 'claude-opus-5-5', modelLabel: 'claude-opus-5-5' },
      sync: { status: 'in_sync', label: 'The diagnosis engine is running the stored model' },
      credential: { configured: true, updatedAt: null, updatedByEmail: null, history: [], usedBy: 'The diagnosis engine (every customer turn) and the Settings connection check.' },
      propagation: { ttlMs: 60000, maxMs: 120000, note: 'New diagnoses use a saved model within about 2 minutes.' } },
    runtimeStatus: { editable: false, architecture: 'ac2', architectureNote: 'Every diagnosis turn runs the advisor.' },
    transcripts: { retentionDays: 90, inactiveAfterMinutes: 120, ttlAttribute: 'expiresAt', summary: 'Kept 90 days.', stored: ['text'], notStored: ['photo bytes'] },
    conversation: { editable: false, source: 'Shipped application configuration', windowTurns: 12, note: 'n' },
    elsewhere: [{ id: 'media', title: 'Media mappings', href: '#media', note: 'Media.' }],
    technical: { diagnosticCacheTtlSeconds: 60, mediaOverlayCacheTtlSeconds: 10, errorCodeOverlayCacheTtlSeconds: 10, conversationWindowTurns: 12, configurationStore: 'store', coldStart: 'c', lastGood: 'l' },
  };
  it('renders the advisor card from GET /admin/settings, sends the model PATCH with the revision and reason, and never shows a key', async () => {
    let patched = null;
    const a = admin(ADMIN, { hash: '#settings', extra: (url, init) => {
      if (url.endsWith('/admin/settings') && (!init.method || init.method === 'GET')) return { status: 200, body: VIEW };
      if (url.endsWith('/admin/settings/model')) { patched = JSON.parse(init.body); const next = JSON.parse(JSON.stringify(VIEW)); next.advisor.version = 4; next.advisor.configured.model = patched.model; next.apply = { written: true, verified: true, version: 4, propagation: 'Stored.' }; return { status: 200, body: next }; }
      if (url.endsWith('/admin/ai-config/models')) return { status: 200, body: { ok: true, configured: true, models: ['claude-a', 'claude-opus-5-5'] } };
      return null;
    } });
    await settle(a.window, 12);
    expect(a.errors).toEqual([]);
    const d = a.document;
    expect(d.getElementById('stAdvisorCard').textContent).toMatch(/Anthropic \(Claude\) — claude-opus-5-5/);
    expect(d.getElementById('stAdvisorCard').textContent).toMatch(/Credential configured/);
    expect(d.getElementById('stRuntimeStatus').textContent).toMatch(/ac2/);
    expect(d.getElementById('shell').textContent).not.toMatch(/Jev|Private AI|OpenAI|COMPOSE|UNDERSTAND/);
    for (const id of ['stJevDlg', 'stLocalModel', 'stFrontierModel', 'stTestLocal', 'stTestFrontier']) expect(d.getElementById(id)).toBeNull();
    // Edit → review → apply, with the revision the page loaded and a reason. jsdom has no <dialog> support: stand in
    // for showModal/close so the staged flow runs as it does in a browser.
    a.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    a.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    d.getElementById('stEditModel').click();
    await settle(a.window);
    d.getElementById('stModel').value = 'claude-a';
    d.getElementById('stEditSave').click();
    await settle(a.window);
    expect(d.getElementById('stConfirmBody').textContent).toMatch(/claude-opus-5-5.*claude-a/);
    d.getElementById('stChangeNote').value = 'Trial the smaller model';
    d.getElementById('stConfirmYes').click();
    await settle(a.window, 12);
    expect(patched).toEqual({ expectedVersion: 3, expectedRevision: '0123456789abcdef', model: 'claude-a', note: 'Trial the smaller model' });
    expect(d.getElementById('stApplyNotice').textContent).toMatch(/Applied and confirmed stored \(version 4\)/);
    expect(a.calls.filter((c) => /jev|diagnostic-inference|local-models|frontier|test-local/.test(c.url))).toEqual([]);
  });
});

describe('test area: the live workbench only', () => {
  it('shows the live test with no scenario or batch tools, and asks nothing of the retired routes', async () => {
    const a = admin(ADMIN, { hash: '#test' });
    await settle(a.window, 12);
    expect(a.errors).toEqual([]);
    const d = a.document;
    expect(d.getElementById('wbForm')).not.toBeNull();
    for (const id of ['wbLoadScenario', 'wbScenarioDlg', 'libListView', 'tacBuilder']) expect(d.getElementById(id)).toBeNull();
    expect(d.querySelectorAll('.test-tab[data-testtab]')).toHaveLength(0);
    expect(a.calls.filter((c) => /library|benchmark/.test(c.url))).toEqual([]);
  });
});
