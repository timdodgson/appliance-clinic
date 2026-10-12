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
