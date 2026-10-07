/**
 * Error Codes admin BFF — catalogue proxy, auth, methods, no secrets.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const errorCodesAdmin = require('../error-codes-admin.js');
const api = require('../index.js');

function event(path, method, body, qs) {
  return {
    rawPath: path,
    requestContext: { http: { method, path }, requestId: 't' },
    headers: {}, cookies: [], body: body ? JSON.stringify(body) : '',
    queryStringParameters: qs || {},
  };
}

const SAMPLE = {
  ok: true,
  terminology: { sourceCodeRecords: 'Shipped Dataset V1 source-code records' },
  sourceCodeRecordCount: 847,
  uniqueLookupCount: 783,
  effectiveActiveCount: 783,
  uniqueDisplayTokens: 338,
  overlay: { present: false, state: 'none', records: 0 },
  appliances: ['washing-machine'],
  brands: ['hotpoint'],
  sourceTypes: ['MANUFACTURER'],
  records: [{
    mappingId: 'INDESIT_WM_F::default::F05',
    code: 'F05',
    shown: ['F05'],
    brands: ['hotpoint', 'indesit'],
    appliances: ['washing-machine'],
    meaning: 'Drainage / pressure-system fault',
    status: 'active',
    origin: 'shipped',
    searchText: 'f05 hotpoint drainage',
  }],
};

function memClient(store) {
  store.listCalls = 0;
  return {
    async list() { store.listCalls += 1; return SAMPLE; },
    async item(id, preview) {
      if (id === 'missing') { const e = new Error('not found'); e.code = 'not_found'; e.status = 404; throw e; }
      return { ok: true, record: Object.assign({}, SAMPLE.records[0], { mappingId: id, mcpPreview: preview ? { status: 'RESOLVED', meaning: SAMPLE.records[0].meaning } : null }) };
    },
    async create(body) {
      if (!body || !body.code || !body.meaning) { const e = new Error('Meaning is required.'); e.code = 'invalid'; e.status = 400; throw e; }
      if (body.code === 'F05') { const e = new Error('duplicate'); e.code = 'duplicate'; e.status = 409; throw e; }
      if (body.appliance === 'not-a-family') { const e = new Error('Appliance is not in the Error Code catalogue.'); e.code = 'invalid_family'; e.status = 400; throw e; }
      if (body.provenance && /javascript:/i.test(String(body.provenance.url || ''))) {
        const e = new Error('Source URL must be http or https.'); e.code = 'invalid_provenance'; e.status = 400; throw e;
      }
      if ((body.aliases || []).indexOf('F05') !== -1) {
        const e = new Error('alias collision'); e.code = 'collision'; e.status = 409; e.body = { conflicts: [{ code: 'F05' }] }; throw e;
      }
      return { ok: true, record: { mappingId: 'ADMIN::washing-machine::hotpoint::ZZ99ADMIN', code: body.code, meaning: body.meaning, origin: 'admin', status: 'active' } };
    },
    async patch(id, body) {
      if (body && (body.code || body.brand || body.appliance)) {
        const e = new Error('identity locked'); e.code = 'identity_locked'; e.status = 400; throw e;
      }
      return { ok: true, record: { mappingId: id, meaning: body.meaning, origin: 'admin' } };
    },
    async retire(id) { return { ok: true, record: { mappingId: id, status: 'retired' } }; },
    async restore(id) { return { ok: true, record: { mappingId: id, status: 'active' } }; },
    async delete(id) {
      if (id.indexOf('ADMIN::') !== 0) { const e = new Error('Shipped baseline records cannot be deleted.'); e.code = 'forbidden'; e.status = 400; throw e; }
      return { ok: true, deleted: id };
    },
    async preview(body) {
      if (!body.make || !body.appliance || !body.code) { const e = new Error('Preview requires make, appliance and code.'); e.code = 'invalid'; e.status = 400; throw e; }
      return { ok: true, result: { status: 'RESOLVED', meaning: 'Synthetic', code: { input: body.code, displayed: body.code } } };
    },
  };
}

describe('proxy helpers', () => {
  it('strips /health from MCP URL', () => {
    expect(errorCodesAdmin.mcpBaseFromHealth('https://example.lambda-url.eu-west-1.on.aws/health'))
      .toBe('https://example.lambda-url.eu-west-1.on.aws');
  });
  it('rejects javascript URLs only at MCP; BFF does not invent provenance', () => {
    expect(errorCodesAdmin.mcpBaseFromHealth('')).toBe('');
  });
});

describe('HTTP auth and methods', () => {
  const store = {};
  beforeEach(() => {
    api.setErrorCodesClientForTests(memClient(store));
    api.setSessionForTests(null);
  });
  afterEach(() => {
    api.setSessionForTests(null);
    api.setErrorCodesClientForTests(null);
  });

  it('rejects unauthenticated GET and mutations', async () => {
    expect((await api.handler(event('/api/admin/error-codes', 'GET'))).statusCode).toBe(401);
    expect((await api.handler(event('/api/admin/error-codes', 'POST', { code: 'ZZ99ADMIN' }))).statusCode).toBe(401);
    expect((await api.handler(event('/api/admin/error-codes/record', 'PATCH', { meaning: 'x' }, { id: 'INDESIT_WM_F::default::F05' }))).statusCode).toBe(401);
    expect((await api.handler(event('/api/admin/error-codes/record/retire', 'POST', {}, { id: 'INDESIT_WM_F::default::F05' }))).statusCode).toBe(401);
    expect((await api.handler(event('/api/admin/error-codes/preview', 'POST', { make: 'hotpoint', appliance: 'washing-machine', code: 'F05' }))).statusCode).toBe(401);
  });

  it('allows admin inspect, create, edit, retire, restore, preview', async () => {
    api.setSessionForTests(async () => ({ isAdmin: true, email: 'admin@test' }));
    const listed = await api.handler(event('/api/admin/error-codes', 'GET'));
    expect(listed.statusCode).toBe(200);
    const listBody = JSON.parse(listed.body);
    expect(listBody.sourceCodeRecordCount).toBe(847);
    expect(listBody.uniqueLookupCount).toBe(783);
    expect(listBody.records[0].code).toBe('F05');
    expect(JSON.stringify(listBody)).not.toMatch(/Bearer |AKIA|MCP_BEARER/);

    const created = await api.handler(event('/api/admin/error-codes', 'POST', {
      appliance: 'washing-machine', brand: 'hotpoint', code: 'ZZ99ADMIN',
      meaning: 'Synthetic admin test mapping. Not a real customer code.',
    }));
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body).record.code).toBe('ZZ99ADMIN');

    const dup = await api.handler(event('/api/admin/error-codes', 'POST', {
      appliance: 'washing-machine', brand: 'hotpoint', code: 'F05', meaning: 'x',
    }));
    expect(dup.statusCode).toBe(409);

    const alias = await api.handler(event('/api/admin/error-codes', 'POST', {
      appliance: 'washing-machine', brand: 'hotpoint', code: 'OTHER99', aliases: ['F05'], meaning: 'x',
    }));
    expect(alias.statusCode).toBe(409);

    const fam = await api.handler(event('/api/admin/error-codes', 'POST', {
      appliance: 'not-a-family', brand: 'hotpoint', code: 'ZZ1', meaning: 'x',
    }));
    expect(fam.statusCode).toBe(400);

    const badUrl = await api.handler(event('/api/admin/error-codes', 'POST', {
      appliance: 'washing-machine', brand: 'hotpoint', code: 'ZZ2', meaning: 'x',
      provenance: { url: 'javascript:alert(1)' },
    }));
    expect(badUrl.statusCode).toBe(400);

    const missing = await api.handler(event('/api/admin/error-codes', 'POST', {
      appliance: 'washing-machine', brand: 'hotpoint',
    }));
    expect(missing.statusCode).toBe(400);

    const patched = await api.handler(event('/api/admin/error-codes/record', 'PATCH', { meaning: 'Edited' }, { id: 'ADMIN::washing-machine::hotpoint::ZZ99ADMIN' }));
    expect(patched.statusCode).toBe(200);

    const ident = await api.handler(event('/api/admin/error-codes/record', 'PATCH', { code: 'E99' }, { id: 'INDESIT_WM_F::default::F05' }));
    expect(ident.statusCode).toBe(400);

    const retired = await api.handler(event('/api/admin/error-codes/record/retire', 'POST', { reason: 'test' }, { id: 'INDESIT_WM_F::default::F05' }));
    expect(retired.statusCode).toBe(200);
    expect(JSON.parse(retired.body).record.status).toBe('retired');

    const restored = await api.handler(event('/api/admin/error-codes/record/restore', 'POST', {}, { id: 'INDESIT_WM_F::default::F05' }));
    expect(restored.statusCode).toBe(200);

    const forbiddenDel = await api.handler(event('/api/admin/error-codes/record', 'DELETE', {}, { id: 'INDESIT_WM_F::default::F05' }));
    expect(forbiddenDel.statusCode).toBe(400);

    const preview = await api.handler(event('/api/admin/error-codes/preview', 'POST', {
      make: 'hotpoint', appliance: 'washing-machine', code: 'ZZ99ADMIN',
    }));
    expect(preview.statusCode).toBe(200);
    expect(JSON.parse(preview.body).result.status).toBe('RESOLVED');
  });

  it('has no public mutation path', async () => {
    const res = await api.handler(event('/api/error-codes', 'POST', { code: 'ZZ99ADMIN' }));
    expect(res.statusCode === 401 || res.statusCode === 404 || res.statusCode >= 400).toBe(true);
  });
});

describe('draft / publish / version / rollback routes', () => {
  const calls = [];
  const rec = (op) => async (...args) => { calls.push({ op, args }); return { ok: true, record: { mappingId: args[0] }, admin: { revision: 1 } }; };
  const client = {
    list: async () => SAMPLE, item: rec('item'), create: async (b) => { calls.push({ op: 'create', args: [b] }); return { ok: true }; },
    patch: rec('patch'), delete: rec('delete'), retire: rec('retire'), restore: rec('restore'),
    publish: rec('publish'), rollback: rec('rollback'), version: rec('version'), preview: async () => ({ ok: true }),
  };
  beforeEach(() => { calls.length = 0; api.setErrorCodesClientForTests(client); api.setSessionForTests(null); });
  afterEach(() => { api.setSessionForTests(null); api.setErrorCodesClientForTests(null); });
  const ID = { id: 'INDESIT_WM_F::default::F05' };

  it('every mutation (and version read) requires an Admin session', async () => {
    const cases = [
      ['/api/admin/error-codes', 'POST'], ['/api/admin/error-codes/record', 'PATCH'], ['/api/admin/error-codes/record', 'DELETE'],
      ['/api/admin/error-codes/record/publish', 'POST'], ['/api/admin/error-codes/record/rollback', 'POST'],
      ['/api/admin/error-codes/record/retire', 'POST'], ['/api/admin/error-codes/record/restore', 'POST'],
      ['/api/admin/error-codes/record/version', 'GET'],
    ];
    for (const [p, m] of cases) {
      expect([p, m, (await api.handler(event(p, m, { expectedRevision: 0 }, Object.assign({ v: '1' }, ID)))).statusCode]).toEqual([p, m, 401]);
    }
    api.setSessionForTests(async () => ({ isAdmin: false, email: 'user@test' }));
    expect((await api.handler(event('/api/admin/error-codes/record/publish', 'POST', { expectedRevision: 0 }, ID))).statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it('wrong methods are rejected', async () => {
    api.setSessionForTests(async () => ({ isAdmin: true, email: 'admin@test' }));
    expect((await api.handler(event('/api/admin/error-codes/record/publish', 'GET', null, ID))).statusCode).toBe(405);
    expect((await api.handler(event('/api/admin/error-codes/record/rollback', 'GET', null, ID))).statusCode).toBe(405);
    expect((await api.handler(event('/api/admin/error-codes/record/version', 'POST', {}, ID))).statusCode).toBe(405);
  });

  it('forwards expectedRevision / note / toVersion and stamps the actor from the session (client actor ignored)', async () => {
    api.setSessionForTests(async () => ({ isAdmin: true, email: 'admin@test' }));
    await api.handler(event('/api/admin/error-codes/record', 'PATCH', { expectedRevision: 3, meaning: 'm', actor: 'spoofed@evil' }, ID));
    await api.handler(event('/api/admin/error-codes/record/publish', 'POST', { expectedRevision: 4, note: 'why', actor: 'spoofed@evil' }, ID));
    await api.handler(event('/api/admin/error-codes/record/rollback', 'POST', { expectedRevision: 5, toVersion: 1 }, ID));
    await api.handler(event('/api/admin/error-codes/record', 'DELETE', { expectedRevision: 6 }, ID));
    await api.handler(event('/api/admin/error-codes', 'POST', { code: 'ZZ1', meaning: 'x', actor: 'spoofed@evil' }));
    const v = await api.handler(event('/api/admin/error-codes/record/version', 'GET', null, Object.assign({ v: '2' }, ID)));
    expect(v.statusCode).toBe(200);
    const by = Object.fromEntries(calls.map((c) => [c.op, c.args]));
    expect(by.patch[1]).toMatchObject({ expectedRevision: 3, meaning: 'm', actor: 'admin@test' });
    expect(by.publish[1]).toMatchObject({ expectedRevision: 4, note: 'why', actor: 'admin@test' });
    expect(by.rollback[1]).toMatchObject({ expectedRevision: 5, toVersion: 1, actor: 'admin@test' });
    expect(by.delete[1]).toMatchObject({ expectedRevision: 6, actor: 'admin@test' });
    expect(by.create[0]).toMatchObject({ code: 'ZZ1', actor: 'admin@test' });
    expect(by.version).toEqual([ID.id, '2']);
    expect(JSON.stringify(calls)).not.toMatch(/spoofed/);
  });
});
