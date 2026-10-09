'use strict';

/** Recalls: the recall store, public lookup handlers and the recall admin routes. */
const recallStoreMod = require('../recalls/store');
const recallHttp = require('../recalls/http');
const recallIngest = require('../recalls/ingest');
const recallAdminMod = require('../recalls/admin');
const { log } = require('../log.js');
const { queryParam, respond } = require('../http-io.js');
const { requireAdmin } = require('../session.js');

let _recallStore = null;
function recallStore() {
  if (_recallStore) return _recallStore;
  try {
    _recallStore = recallStoreMod.createDynamoStore();
  } catch (e) {
    log({ evt: 'recall-store-init-failed', error: String(e && e.message || e) });
    _recallStore = recallStoreMod.createMemoryStore();
  }
  return _recallStore;
}
function setRecallStore(store) { _recallStore = store; }
const recallHandlers = recallHttp.createHandlers(recallStore, (opts) => recallIngest.run(Object.assign({ store: recallStore() }, opts)));

const recallAdmin = recallAdminMod.createAdmin(() => recallStore(), { publishSite: (store, nowIso, put, unlisted) => recallIngest.publishSite(store, nowIso, put, unlisted) });
// Recall notice decisions (Safety area): auth FIRST, actor from the session, expectedRevision required.
function recallAdminError(e) {
  const status = (e && e.status) || 500;
  const body = { error: (e && e.message) || 'Recall notice update failed', code: (e && e.code) || 'error' };
  if (e && e.extra) Object.assign(body, e.extra);
  if (status >= 500) log({ evt: 'recall-admin-failed', code: body.code, error: String(e && e.message || e).slice(0, 180) });
  return respond(status, body);
}
async function recallAdminRoute(event, method, allowed, run) {
  const session = await requireAdmin(event);
  if (!session) return respond(401, { error: 'Unauthorized' });
  if (allowed.indexOf(method) === -1) return respond(405, { error: allowed.join(' or ') + ' only' });
  let body = {};
  if (method !== 'GET' && event.body) {
    try { body = JSON.parse(event.body); } catch { return respond(400, { error: 'invalid JSON', code: 'json' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(400, { error: 'invalid JSON', code: 'json' });
  }
  delete body.actor;
  body.actor = session.email || session.username || null;
  try { return respond(200, await run(body, queryParam(event, 'id'))); }
  catch (e) { return recallAdminError(e); }
}

module.exports = { recallStore, setRecallStore, recallHandlers, recallAdmin, recallAdminRoute };
