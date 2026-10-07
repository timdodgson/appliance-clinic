'use strict';

/**
 * Evidence-based model → part fit classification.
 *
 * Catalogue compatibility is a FACT after diagnosis. These helpers never
 * raise diagnostic confidence. Confirmed fit requires a unique catalogue
 * model resolution AND an explicit modelPart join for that exact SKU.
 */

const FIT_STATE = {
  CONFIRMED_FIT: 'CONFIRMED_FIT',
  VERIFY_FIT: 'VERIFY_FIT',
  NO_FIT_EVIDENCE: 'NO_FIT_EVIDENCE',
  INCOMPATIBLE: 'INCOMPATIBLE',
};

const MATCH_TYPE = {
  NONE: 'none',
  EXACT: 'exact',
  UNIQUE_SUFFIX: 'unique_suffix',
  INCOMPLETE: 'incomplete',
  AMBIGUOUS: 'ambiguous',
  MAKE_CONFLICT: 'make_conflict',
  NOT_FOUND: 'not_found',
};

const UNIQUE_MATCH_TYPES = new Set([MATCH_TYPE.EXACT, MATCH_TYPE.UNIQUE_SUFFIX]);

/** Factory / country suffixes that complete a model number without selecting a different variant. */
const COUNTRY = 'GB|EU|US|UK|DE|FR|IT|ES|AU|NZ|NL|BE|IE|AT|CH|SE|NO|DK|FI|PL|PT';
const SUFFIX_RE = new RegExp(`^(?:${COUNTRY})?\\d{0,4}$`);

const MIN_LOOKUP = 2;
const MIN_SUFFIX_QUERY = 5;

function normalizeModelKey(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function normalizeMakeKey(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function isUniqueCatalogueMatch(matchType) {
  return UNIQUE_MATCH_TYPES.has(matchType);
}

function makesAgree(requested, catalogue) {
  if (!requested) return true;
  if (!catalogue) return false;
  const a = normalizeMakeKey(requested);
  const b = normalizeMakeKey(catalogue);
  if (!a) return true;
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

function remainderAfterPrefix(queryNorm, storedNorm) {
  if (!queryNorm || !storedNorm) return null;
  if (storedNorm === queryNorm) return { kind: MATCH_TYPE.EXACT, rest: '' };
  if (queryNorm.length < MIN_SUFFIX_QUERY) return null;
  if (!storedNorm.startsWith(queryNorm)) return null;
  const rest = storedNorm.slice(queryNorm.length);
  if (rest && SUFFIX_RE.test(rest)) return { kind: MATCH_TYPE.UNIQUE_SUFFIX, rest };
  return null;
}

/**
 * Classify how a customer model string maps onto catalogue model rows.
 * `matches` are catalogue rows `{ model, make, category? }` — never parts.
 * Does not use contains/LIKE fuzzy matching to manufacture a unique hit.
 */
function classifyModelResolution({ query, matches, requestedMake } = {}) {
  const q = String(query || '').trim();
  const qn = normalizeModelKey(q);
  const rows = Array.isArray(matches) ? matches.filter((m) => m && (m.model || m.modelNumber)) : [];
  const normalisedRows = rows.map((m) => ({
    model: m.model || m.modelNumber,
    make: m.make || null,
    category: m.category || null,
    modelId: m.modelId,
    key: normalizeModelKey(m.model || m.modelNumber),
  }));

  if (!qn || qn.length < MIN_LOOKUP) {
    return { matchType: MATCH_TYPE.NONE, resolvedModel: null, candidates: [], reason: 'missing_or_short_query' };
  }

  if (normalisedRows.length === 0) {
    return { matchType: MATCH_TYPE.NOT_FOUND, resolvedModel: null, candidates: [], reason: 'no_catalogue_row' };
  }

  const agreeing = normalisedRows.filter((r) => makesAgree(requestedMake, r.make));
  if (requestedMake && agreeing.length === 0 && normalisedRows.length > 0) {
    return {
      matchType: MATCH_TYPE.MAKE_CONFLICT,
      resolvedModel: null,
      candidates: normalisedRows,
      reason: 'requested_make_disagrees_with_catalogue_row',
    };
  }

  const pool = agreeing.length ? agreeing : normalisedRows;

  const exact = pool.filter((r) => r.key === qn);
  if (exact.length === 1) {
    return { matchType: MATCH_TYPE.EXACT, resolvedModel: exact[0].model, candidates: exact, reason: 'normalised_equality' };
  }
  if (exact.length > 1) {
    return { matchType: MATCH_TYPE.AMBIGUOUS, resolvedModel: null, candidates: exact, reason: 'multiple_normalised_equals' };
  }

  const suffixHits = pool
    .map((r) => ({ row: r, hit: remainderAfterPrefix(qn, r.key) }))
    .filter((x) => x.hit);
  if (suffixHits.length === 1) {
    return {
      matchType: suffixHits[0].hit.kind,
      resolvedModel: suffixHits[0].row.model,
      candidates: [suffixHits[0].row],
      reason: 'unique_factory_or_country_suffix',
    };
  }
  if (suffixHits.length > 1) {
    return {
      matchType: MATCH_TYPE.AMBIGUOUS,
      resolvedModel: null,
      candidates: suffixHits.map((x) => x.row),
      reason: 'multiple_suffix_completions',
    };
  }

  const prefix = pool.filter((r) => r.key.startsWith(qn) || qn.startsWith(r.key));
  if (prefix.length >= 1) {
    return {
      matchType: MATCH_TYPE.INCOMPLETE,
      resolvedModel: null,
      candidates: prefix,
      reason: 'prefix_is_not_a_unique_factory_suffix',
    };
  }

  return {
    matchType: MATCH_TYPE.NOT_FOUND,
    resolvedModel: null,
    candidates: pool,
    reason: 'no_deterministic_match',
  };
}

function hasInsufficientCompatibilityNote(title) {
  const t = String(title || '').toLowerCase();
  if (/serial\s*number\s*depend/.test(t)) return true;
  if (/please contact us to confirm/.test(t)) return true;
  return false;
}

/**
 * Fit of one SKU given a model-resolution result.
 * `onResolvedModelList` is true only when the SKU is on that unique model's modelPart list.
 */
function classifyPartFit({
  matchType,
  onResolvedModelList,
  brandOnly,
  title,
} = {}) {
  const unique = isUniqueCatalogueMatch(matchType);
  if (brandOnly || !unique) return FIT_STATE.VERIFY_FIT;
  if (!onResolvedModelList) return FIT_STATE.INCOMPATIBLE;
  if (hasInsufficientCompatibilityNote(title)) return FIT_STATE.VERIFY_FIT;
  return FIT_STATE.CONFIRMED_FIT;
}

/**
 * Choose which retrieved parts may be presented, and stamp fitState.
 * Component matching filters presentation; it never creates CONFIRMED_FIT.
 */
function selectFitParts({
  matchType,
  modelParts,
  brandParts,
  diagnosedComponents,
  matchesComponent,
} = {}) {
  const unique = isUniqueCatalogueMatch(matchType);
  const matcher = typeof matchesComponent === 'function'
    ? matchesComponent
    : () => false;
  const comps = (diagnosedComponents || []).map((c) => String(c || '').toLowerCase().trim()).filter(Boolean);

  if (!unique) {
    const src = Array.isArray(brandParts) ? brandParts : [];
    return {
      fitSet: src.length ? FIT_STATE.VERIFY_FIT : FIT_STATE.NO_FIT_EVIDENCE,
      parts: src.map((p) => ({
        ...p,
        fitState: FIT_STATE.VERIFY_FIT,
        _brandOnly: true,
      })),
    };
  }

  const listed = (modelParts || []).map((p) => {
    const fitState = classifyPartFit({
      matchType,
      onResolvedModelList: true,
      brandOnly: false,
      title: p.title,
    });
    return {
      ...p,
      fitState,
      _brandOnly: fitState !== FIT_STATE.CONFIRMED_FIT,
      _onModelList: true,
    };
  });

  const matching = comps.length
    ? listed.filter((p) => comps.some((c) => matcher(p.title || '', c)))
    : listed;

  if (matching.length === 0) {
    return { fitSet: FIT_STATE.NO_FIT_EVIDENCE, parts: [] };
  }
  return {
    fitSet: matching.every((p) => p.fitState === FIT_STATE.CONFIRMED_FIT)
      ? FIT_STATE.CONFIRMED_FIT
      : FIT_STATE.VERIFY_FIT,
    parts: matching,
  };
}

/** BFF/card mapping: never MODEL_CONFIRMED without unique catalogue resolution + CONFIRMED_FIT. */
function cardFitStatus(part, { catalogueMatchType } = {}) {
  const unique = isUniqueCatalogueMatch(catalogueMatchType);
  if (part && part.fitState === FIT_STATE.INCOMPATIBLE) return null;
  if (part && part.fitState === FIT_STATE.NO_FIT_EVIDENCE) return null;
  if (part && part.fitState === FIT_STATE.CONFIRMED_FIT && unique) return 'MODEL_CONFIRMED';
  return 'VERIFY_FIT';
}

function shouldBrandSearch({ matchType, cannotProvideModel, hasMake } = {}) {
  if (isUniqueCatalogueMatch(matchType)) return false;
  if (matchType === MATCH_TYPE.AMBIGUOUS || matchType === MATCH_TYPE.INCOMPLETE || matchType === MATCH_TYPE.MAKE_CONFLICT) {
    return false;
  }
  if (matchType === MATCH_TYPE.NOT_FOUND || matchType === MATCH_TYPE.NONE) {
    return Boolean(hasMake) || Boolean(cannotProvideModel);
  }
  return false;
}

function shouldAskForFullerModel(matchType) {
  return matchType === MATCH_TYPE.AMBIGUOUS
    || matchType === MATCH_TYPE.INCOMPLETE
    || matchType === MATCH_TYPE.MAKE_CONFLICT;
}

module.exports = {
  FIT_STATE,
  MATCH_TYPE,
  UNIQUE_MATCH_TYPES,
  normalizeModelKey,
  normalizeMakeKey,
  isUniqueCatalogueMatch,
  makesAgree,
  classifyModelResolution,
  classifyPartFit,
  selectFitParts,
  hasInsufficientCompatibilityNote,
  cardFitStatus,
  shouldBrandSearch,
  shouldAskForFullerModel,
};
