'use strict';

/** Admin: error-code catalogue routes, through the error-code MCP. */
const errorCodesAdmin = require('../error-codes-admin');
const { MCP_HEALTH_URL, MCP_BEARER_TOKEN, MCP_URL } = require('../config.js');
const { parseJsonBody, queryParam, fetchHealth, respond } = require('../http-io.js');
const { requireAdmin } = require('../session.js');

let _errorCodesClient = null;
let _errorCodesTestMode = false;
function errorCodeClient() {
  if (_errorCodesClient) return _errorCodesClient;
  _errorCodesClient = errorCodesAdmin.createClient({
    mcpUrl: MCP_URL,
    token: MCP_BEARER_TOKEN,
  });
  return _errorCodesClient;
}
function setErrorCodesClientForTests(client) {
  _errorCodesClient = client;
  _errorCodesTestMode = client != null;
}
function errorCodesHttpError(e) {
  const mapped = errorCodesAdmin.httpError(e);
  return respond(mapped.status, mapped.body);
}

async function adminErrorCodes(event) {
  const session = await requireAdmin(event);
  if (!session) return respond(401, { error: 'Unauthorized' });
  const method =
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.httpMethod || 'GET';
  try {
    if (method === 'GET') {
      const cat = await errorCodeClient().list();
      const health = (!_errorCodesTestMode && MCP_HEALTH_URL) ? await fetchHealth(MCP_HEALTH_URL, 5000) : null;
      const h = (health && health.json) || {};
      return respond(200, Object.assign({}, cat, {
        datasetV1Hash: h.datasetV1Hash || null,
        enrichmentV1Hash: h.enrichmentV1Hash || null,
        service: h.service || cat.service || 'error-code-mcp',
        version: h.version || null,
        datasetVersion: h.datasetVersion || '1',
        mappingCount: h.mappingCount != null ? h.mappingCount : cat.sourceCodeRecordCount,
        note: (cat.terminology && cat.terminology.sourceCodeRecords) || '',
      }));
    }
    if (method === 'POST') {
      const body = await parseJsonBody(event);
      // Creates a DRAFT. Nothing is live until it is explicitly published.
      const rec = await errorCodeClient().create(errorCodesAdmin.withActor(body, session));
      return respond(201, rec);
    }
    return respond(405, { error: 'GET or POST' });
  } catch (e) { return errorCodesHttpError(e); }
}

async function adminErrorCodeRecord(event) {
  const session = await requireAdmin(event);
  if (!session) return respond(401, { error: 'Unauthorized' });
  const method =
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.httpMethod || 'GET';
  const id = queryParam(event, 'id');
  if (!id) return respond(400, { error: 'id required' });
  try {
    if (method === 'GET') {
      const preview = queryParam(event, 'preview');
      const rec = await errorCodeClient().item(id, preview === '1' || preview === 'true');
      return respond(200, rec);
    }
    if (method === 'PATCH') {
      // Saves a DRAFT (live diagnosis unchanged). expectedRevision is required.
      const body = await parseJsonBody(event);
      const rec = await errorCodeClient().patch(id, errorCodesAdmin.withActor(body, session));
      return respond(200, rec);
    }
    if (method === 'DELETE') {
      const body = event.body ? await parseJsonBody(event) : {};
      if (body.expectedRevision == null && queryParam(event, 'expectedRevision') != null) body.expectedRevision = queryParam(event, 'expectedRevision');
      const rec = await errorCodeClient().delete(id, errorCodesAdmin.withActor(body, session));
      return respond(200, rec);
    }
    return respond(405, { error: 'GET, PATCH or DELETE' });
  } catch (e) { return errorCodesHttpError(e); }
}

// Every Error Code mutation: Admin session required; the actor comes from that session.
async function adminErrorCodeAction(event, action) {
  const session = await requireAdmin(event);
  if (!session) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  if (!id) return respond(400, { error: 'id required' });
  try {
    const body = event.body ? await parseJsonBody(event) : {};
    return respond(200, await errorCodeClient()[action](id, errorCodesAdmin.withActor(body, session)));
  } catch (e) { return errorCodesHttpError(e); }
}
function adminErrorCodeRetire(event) { return adminErrorCodeAction(event, 'retire'); }
function adminErrorCodeRestore(event) { return adminErrorCodeAction(event, 'restore'); }
async function adminErrorCodeVersion(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  const id = queryParam(event, 'id');
  const v = queryParam(event, 'v');
  if (!id || v == null || v === '') return respond(400, { error: 'id and v required' });
  try {
    return respond(200, await errorCodeClient().version(id, v));
  } catch (e) { return errorCodesHttpError(e); }
}

async function adminErrorCodePreview(event) {
  if (!(await requireAdmin(event))) return respond(401, { error: 'Unauthorized' });
  try {
    const body = await parseJsonBody(event);
    return respond(200, await errorCodeClient().preview(body));
  } catch (e) { return errorCodesHttpError(e); }
}

module.exports = {
  setErrorCodesClientForTests, adminErrorCodes, adminErrorCodeRecord, adminErrorCodeAction, adminErrorCodeRetire,
  adminErrorCodeRestore, adminErrorCodeVersion, adminErrorCodePreview,
};
