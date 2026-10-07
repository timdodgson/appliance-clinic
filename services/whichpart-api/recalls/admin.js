'use strict';

/**
 * Admin recall-notice decisions (Safety area).
 *
 * The official OPSS notice content is NEVER edited here. Admin owns only ApplianceClinic's LISTING
 * decision for a notice: list it in the Recall Centre (with an appliance family) / archive it / follow
 * the classifier. Lifecycle:
 *
 *   Save draft  → stored on the record (admin.draft). No customer effect: the public API, Recall Centre
 *                 pages and WebMCP read only rows whose EFFECTIVE state is published.
 *   Publish     → the draft becomes the live decision as a new immutable version (vN). Customer-facing.
 *   Archive     → a new version that stops the notice being listed. Source content + history are kept.
 *   Restore     → a new version restoring the last non-archive decision.
 *   Rollback    → a new version carrying an older version's decision (v0 = "as ingested": classifier).
 *
 * Every mutation: admin session (actor from the session, never the client), expectedRevision (stale
 * editor → 409), conditional row write (ingest racing → retried on fresh state), and live actions hold
 * the ingest lock while the static Recall Centre pages are regenerated.
 */

const lifecycle = require('./lifecycle');
const observe = require('./observe');
const { familyOf, FAMILIES } = require('./families');

const NOTE_MIN = 5;
const NOTE_MAX = 300;
const WRITE_RETRIES = 3;
const CONFLICT = ['conflict', 'source_changed', 'draft_pending', 'invalid_state', 'ingest_running', 'no_draft'];

function err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  e.status = code === 'not_found' ? 404 : (CONFLICT.indexOf(code) !== -1 ? 409 : 400);
  if (extra) e.extra = extra;
  return e;
}
function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
function iso(d) { return (d || new Date()).toISOString(); }
function cleanNote(n) { return String(n == null ? '' : n).replace(/\s+/g, ' ').trim(); }

function adminOf(rec) {
  const a = rec.admin || {};
  return { revision: a.revision || 0, live: a.live || null, draft: a.draft || null, versions: a.versions || [], currentVersion: a.currentVersion || 0 };
}

function summary(rec) {
  const e = lifecycle.effective(rec);
  const fam = familyOf(e.family);
  const a = adminOf(rec);
  const p = rec.presentation || {};
  return {
    id: rec.contentId,
    slug: rec.slug,
    title: rec.title,
    sourceType: rec.sourceType,
    riskLevel: rec.riskLevel || null,
    alertDate: rec.alertDate || null,
    psdNumber: rec.psdNumber || null,
    brand: rec.brand || null,
    productName: rec.productName || null,
    models: (rec.models || []).slice(0, 6),
    modelCount: (rec.models || []).length,
    family: e.family || null,
    familyName: fam ? fam.name : null,
    state: e.state,
    stateLabel: lifecycle.STATE_LABELS[e.state] || e.state,
    decidedBy: e.by,
    classifierReason: (rec.classification && rec.classification.reason) || null,
    draftPending: !!a.draft,
    currentVersion: a.currentVersion,
    revision: a.revision,
    sourceUrl: rec.sourceUrl,
    lastCheckedAt: rec.lastCheckedAt || null,
    lastChangedAt: rec.lastChangedAt || null,
    sourceRevisionCount: (rec.sourceRevisions || []).length,
    withdrawn: !!rec.withdrawn,
    stopUseIndicatedBySource: !!p.stopUseIndicatedBySource,
    identityRangeNeeded: !!p.identityRangeNeeded,
  };
}

function customerImpact(rec) {
  const e = lifecycle.effective(rec);
  const listed = e.state === 'published';
  return {
    listed,
    publicPage: listed ? '/recalls/' + rec.slug + '/' : null,
    lookup: listed,
    webmcpCheckRecall: listed,
    diagnosis: false,
    note: listed
      ? 'Listed: customers can find this notice in the Recall Centre, the recall lookup, and the WebMCP checkRecall tool. Recall notices never change diagnosis, STOP behaviour or parts.'
      : 'Not listed: customers do not see this notice in the Recall Centre, the recall lookup or WebMCP. The official GOV.UK record is unaffected.',
  };
}

function detail(rec) {
  const a = adminOf(rec);
  const e = lifecycle.effective(rec);
  const draftEff = a.draft ? lifecycle.effective(Object.assign({}, rec, { admin: Object.assign({}, rec.admin, { live: a.draft }) })) : null;
  return Object.assign(summary(rec), {
    families: FAMILIES.map((f) => ({ id: f.id, name: f.name })),
    stateLabels: lifecycle.STATE_LABELS,
    source: {
      organisation: 'UK Office for Product Safety and Standards (OPSS)',
      via: 'GOV.UK content API',
      noticeId: rec.contentId,
      psdNumber: rec.psdNumber || null,
      sourceUrl: rec.sourceUrl,
      sourceType: rec.sourceType,
      sourceTypeRaw: rec.sourceTypeRaw || null,
      sourceCategory: rec.sourceCategory || null,
      alertDate: rec.alertDate || null,
      firstPublishedAt: rec.firstPublishedAt || null,
      publicUpdatedAt: rec.publicUpdatedAt || null,
      firstSeenAt: rec.firstSeenAt || null,
      lastCheckedAt: rec.lastCheckedAt || null,
      lastChangedAt: rec.lastChangedAt || null,
      bodyHash: rec.bodyHash || null,
      withdrawn: rec.withdrawn || null,
      changeHistory: rec.changeHistory || [],
      attribution: 'Contains public sector information licensed under the Open Government Licence v3.0.',
    },
    notice: {
      title: rec.title,
      description: rec.description || null,
      productType: rec.productType || null,
      productName: rec.productName || null,
      productDescription: rec.productDescription || null,
      brand: rec.brand || null,
      models: rec.models || [],
      modelText: rec.modelText || null,
      batchText: rec.batchText || null,
      serialText: rec.serialText || null,
      identifiers: rec.identifiers || null,
      countryOfOrigin: rec.countryOfOrigin || null,
      riskLevel: rec.riskLevel || null,
      measureTypes: rec.measureTypes || [],
      hazard: rec.hazard || null,
      correctiveAction: rec.correctiveAction || null,
      manufacturerUrl: rec.manufacturerUrl || null,
      attachments: rec.attachments || [],
      stopUseIndicatedBySource: !!(rec.presentation && rec.presentation.stopUseIndicatedBySource),
      identityRangeNeeded: !!(rec.presentation && rec.presentation.identityRangeNeeded),
    },
    classification: Object.assign({}, rec.classification || {}, { family: lifecycle.classifierFamily(rec), state: lifecycle.classifierState(rec) }),
    validation: rec.validation || null,
    effective: e,
    customerImpact: customerImpact(rec),
    sourceRevisions: (rec.sourceRevisions || []).slice().reverse(),
    hashRevisions: rec.revisions || [],
    admin: {
      revision: a.revision,
      currentVersion: a.currentVersion,
      liveDecision: a.live,
      draft: a.draft,
      draftEffect: draftEff ? { state: draftEff.state, family: draftEff.family, listed: draftEff.state === 'published' } : null,
      versions: lifecycle.versionList(rec),
      canEdit: e.state !== 'withdrawn',
      canPublish: !!a.draft && e.state !== 'withdrawn',
      canDiscard: !!a.draft,
      canArchive: e.state === 'published' && !a.draft,
      canRestore: !!(a.live && a.live.status === 'archived') && e.state !== 'withdrawn',
      canRollback: e.state !== 'withdrawn' && !a.draft && lifecycle.versionList(rec).length > 1,
      canDelete: false,
      deleteNote: 'Official notices are never deleted. Archive stops listing; the source record and history are kept.',
    },
  });
}

function validateDecision(input) {
  const fields = [];
  const family = String((input && input.family) || '').trim();
  if (!familyOf(family)) fields.push('family');
  const note = cleanNote(input && input.note);
  if (note.length < NOTE_MIN) fields.push('note');
  if (note.length > NOTE_MAX) fields.push('note');
  if (fields.length) {
    throw err('invalid', fields.indexOf('family') !== -1
      ? 'Choose the ApplianceClinic appliance family this notice belongs to.'
      : 'Add a reason (5–300 characters) explaining why this listing decision is correct.', { fields });
  }
  return { status: 'published', family, note };
}

function createAdmin(getStore, deps) {
  deps = deps || {};
  const nowFn = deps.now || (() => new Date());
  const publishSite = deps.publishSite || null; // (store, nowIso, putObject, unpublish[]) → {pages}

  async function load(id) {
    const rec = await getStore().get(String(id || ''));
    if (!rec) throw err('not_found', 'Recall notice not found.');
    return rec;
  }
  function checkRevision(rec, expected) {
    if (expected === undefined || expected === null || expected === '') throw err('revision_required', 'expectedRevision is required. Reload this notice and try again.');
    const cur = adminOf(rec).revision;
    if (Number(expected) !== cur) throw err('conflict', 'Someone else changed this notice. Reload to see the latest version, then try again.', { currentRevision: cur });
  }
  function checkSource(rec, expectedSourceHash) {
    if (expectedSourceHash && rec.bodyHash && expectedSourceHash !== rec.bodyHash) {
      throw err('source_changed', 'The official notice was updated since you opened it. Reload and review the new content before publishing.');
    }
  }

  /** Load → fn(rec) mutates → conditional write; a racing ingest write is re-read and re-validated. */
  async function mutate(id, input, fn) {
    for (let i = 0; i < WRITE_RETRIES; i += 1) {
      const rec = await load(id);
      checkRevision(rec, input && input.expectedRevision);
      const expectedRev = rec._rev || 0;
      const before = lifecycle.effective(rec).state;
      const result = fn(rec);
      rec.admin = rec.admin || {};
      rec.admin.revision = (rec.admin.revision || 0) + 1;
      lifecycle.applyEffective(rec);
      try {
        await getStore().put(rec, { expectedRev });
        return { rec, result, before, after: rec.state };
      } catch (e) {
        if (e && e.code === 'precondition') continue;
        throw e;
      }
    }
    throw err('conflict', 'The notice changed while saving. Reload and try again.');
  }

  /** Customer-facing change: serialise with ingest, write, then regenerate the static Recall Centre. */
  async function live(id, input, fn) {
    const store = getStore();
    const now = nowFn();
    const runId = 'adm-' + observe.newRunId(now);
    let locked = false;
    if (typeof store.tryLock === 'function') {
      const got = await store.tryLock({ runId, trigger: 'admin', startedAt: iso(now), expiresAt: new Date(now.getTime() + observe.LOCK_TTL_MS).toISOString() }, now);
      if (!got.ok) throw err('ingest_running', 'An ingest is running. Try again when it finishes; nothing was changed.');
      locked = true;
    }
    try {
      const out = await mutate(id, input, fn);
      let pages = null;
      if (publishSite) {
        const unlisted = out.before === 'published' && out.after !== 'published'
          ? [{ slug: out.rec.slug, sourceUrl: out.rec.sourceUrl, title: out.rec.title }] : [];
        try { pages = await publishSite(store, iso(nowFn()), undefined, unlisted); }
        catch (e) { pages = { error: String(e && e.message || e).slice(0, 180) }; }
      }
      return Object.assign(detail(out.rec), { applied: out.result, publicPages: pages });
    } finally {
      if (locked && typeof store.releaseLock === 'function') { try { await store.releaseLock(runId); } catch { /* expires */ } }
    }
  }

  function appendVersion(rec, action, decision, input, extra) {
    const a = rec.admin || (rec.admin = {});
    const versions = (a.versions || []).slice();
    const n = (versions.length ? versions[versions.length - 1].version : 0) + 1;
    const prevDecision = a.live || null;
    const nextRec = Object.assign({}, rec, { admin: Object.assign({}, a, { live: decision }) });
    versions.push(Object.assign({
      version: n,
      action,
      at: iso(nowFn()),
      by: (input && input.actor) || null,
      note: cleanNote(input && input.note) || (decision && decision.note) || null,
      decision: clone(decision),
      sourceHash: rec.bodyHash || null,
      changed: lifecycle.decisionChanged(prevDecision, decision),
      previousRevision: a.revision || 0,
      newRevision: (a.revision || 0) + 1,
      effectiveState: lifecycle.effective(nextRec).state,
    }, extra || {}));
    a.versions = versions;
    a.currentVersion = n;
    a.live = clone(decision);
    return n;
  }

  async function list(qs) {
    qs = qs || {};
    const rows = (await getStore().listAll()).map(summary);
    const counts = {};
    rows.forEach((r) => { counts[r.state] = (counts[r.state] || 0) + 1; });
    const drafts = rows.filter((r) => r.draftPending).length;
    const state = String(qs.state || '');
    const family = String(qs.family || '');
    const sourceType = String(qs.sourceType || '');
    const q = String(qs.q || '').trim().toLowerCase().slice(0, 80);
    let out = rows;
    if (state === 'draft') out = out.filter((r) => r.draftPending);
    else if (state) out = out.filter((r) => r.state === state);
    if (family) out = out.filter((r) => r.family === family);
    if (sourceType) out = out.filter((r) => r.sourceType === sourceType);
    if (q) {
      out = out.filter((r) => [r.title, r.brand, r.productName, r.psdNumber, r.slug, r.id, (r.models || []).join(' ')]
        .join(' ').toLowerCase().indexOf(q) !== -1);
    }
    return {
      total: rows.length,
      matching: out.length,
      counts,
      draftCount: drafts,
      stateLabels: lifecycle.STATE_LABELS,
      families: FAMILIES.map((f) => ({ id: f.id, name: f.name })),
      records: out.slice(0, 200),
      truncated: out.length > 200,
    };
  }

  async function get(id) { return detail(await load(id)); }

  async function version(id, v) {
    const rec = await load(id);
    const k = Number(v);
    const versions = lifecycle.versionList(rec);
    const hit = versions.find((x) => x.version === k);
    if (!hit) throw err('not_found', 'Version not found.');
    const decision = k === 0 ? null : hit.decision;
    const eff = lifecycle.effective(Object.assign({}, rec, { admin: Object.assign({}, rec.admin, { live: decision }) }));
    let source = null;
    if (hit.sourceHash && hit.sourceHash !== rec.bodyHash) {
      source = (rec.sourceRevisions || []).find((s) => s.bodyHash === hit.sourceHash) || null;
    }
    return Object.assign({}, hit, {
      effectWithCurrentSource: { state: eff.state, family: eff.family, listed: eff.state === 'published' },
      sourceAtThatTime: source ? { title: source.title, alertDate: source.alertDate, hazard: source.hazard, correctiveAction: source.correctiveAction, models: source.models, supersededAt: source.supersededAt } : null,
      sameSourceAsCurrent: !hit.sourceHash || hit.sourceHash === rec.bodyHash,
    });
  }

  async function saveDraft(id, input) {
    const decision = validateDecision(input);
    const out = await mutate(id, input, (rec) => {
      if (lifecycle.effective(rec).state === 'withdrawn') throw err('invalid_state', 'OPSS has withdrawn this notice. It cannot be listed.');
      rec.admin = rec.admin || {};
      rec.admin.draft = Object.assign({}, decision, { savedAt: iso(nowFn()), savedBy: (input && input.actor) || null, sourceHash: rec.bodyHash || null });
    });
    return detail(out.rec);
  }

  async function discardDraft(id, input) {
    const out = await mutate(id, input, (rec) => {
      if (!rec.admin || !rec.admin.draft) throw err('no_draft', 'There is no draft to discard.');
      rec.admin.draft = null;
    });
    return detail(out.rec);
  }

  function publish(id, input) {
    return live(id, input, (rec) => {
      const a = rec.admin || {};
      if (!a.draft) throw err('no_draft', 'There is no draft to publish.');
      if (rec.withdrawn) throw err('invalid_state', 'OPSS has withdrawn this notice. It cannot be listed.');
      checkSource(rec, input && input.expectedSourceHash);
      const decision = validateDecision(a.draft);
      const n = appendVersion(rec, 'publish', decision, Object.assign({}, input, { note: (input && input.note) || a.draft.note }));
      a.draft = null;
      return { version: n };
    });
  }

  function archive(id, input) {
    return live(id, input, (rec) => {
      const reason = cleanNote(input && input.reason);
      if (reason.length < NOTE_MIN) throw err('invalid', 'Add a reason (5–300 characters) for archiving this notice.', { fields: ['reason'] });
      const e = lifecycle.effective(rec);
      if (e.state !== 'published') throw err('invalid_state', 'Only a listed notice can be archived.');
      if (rec.admin && rec.admin.draft) throw err('draft_pending', 'Publish or discard the pending draft first.');
      const n = appendVersion(rec, 'archive', { status: 'archived', family: e.family || null, note: reason.slice(0, NOTE_MAX) }, Object.assign({}, input, { note: reason }));
      return { version: n };
    });
  }

  function restore(id, input) {
    return live(id, input, (rec) => {
      const a = rec.admin || {};
      if (!(a.live && a.live.status === 'archived')) throw err('invalid_state', 'This notice is not archived.');
      if (rec.withdrawn) throw err('invalid_state', 'OPSS has withdrawn this notice. It cannot be listed.');
      const prior = (a.versions || []).slice().reverse().find((v) => !(v.decision && v.decision.status === 'archived') && v.action !== 'archive');
      const decision = prior ? clone(prior.decision) : null;
      const n = appendVersion(rec, 'restore', decision, Object.assign({ note: 'Restored' }, input), { restoredFrom: prior ? prior.version : 0 });
      return { version: n };
    });
  }

  function rollback(id, input) {
    return live(id, input, (rec) => {
      const a = rec.admin || {};
      if (a.draft) throw err('draft_pending', 'Publish or discard the pending draft before rolling back.');
      if (rec.withdrawn) throw err('invalid_state', 'OPSS has withdrawn this notice. It cannot be listed.');
      const k = Number(input && input.toVersion);
      if (!Number.isInteger(k) || k < 0) throw err('invalid', 'Choose a version to roll back to.');
      if (k === (a.currentVersion || 0)) throw err('invalid', 'That version is already live.');
      let decision = null;
      if (k > 0) {
        const src = (a.versions || []).find((v) => v.version === k);
        if (!src) throw err('not_found', 'Version v' + k + ' not found.');
        decision = clone(src.decision);
      }
      const n = appendVersion(rec, 'rollback', decision, Object.assign({ note: 'Rollback to ' + (k === 0 ? 'as ingested' : 'v' + k) }, input), { rolledBackFrom: k });
      return { version: n };
    });
  }

  return { list, get, version, saveDraft, discardDraft, publish, archive, restore, rollback, summary, detail };
}

module.exports = { createAdmin, summary, detail, validateDecision, err, NOTE_MIN, NOTE_MAX };
