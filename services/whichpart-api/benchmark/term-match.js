'use strict';
/**
 * AUTHORITATIVE benchmark term matcher (shared, zero-dependency).
 *
 * ONE implementation of the shared evaluation primitive: "does this expected DOMAIN TERM occur in
 * this response text?". Every benchmark/eval runner (ACQ scorer + simulator, the 277 release gate
 * quality-suite, the customer-journey runner, and the engineering challenge runner) MUST consume
 * this module rather than reimplement its own sigWords/termPresent — so the SAME customer response
 * can never be judged differently by different runners.
 *
 * Semantics (the proven ACQ "v2" contract):
 *   - Significance is STOP-WORD based, not word-LENGTH based. Word length is not a significance gate;
 *     the intent (ignore function words) is carried by STOP. This is why the previous length>=4 rule
 *     wrongly made meaningful short domain terms (fan/gas/ice/pcb/ntc/tap/bag) impossible to match.
 *   - sigWords: PRIMARY = content words length>=4; only when a term has NO long content word does it
 *     fall back to its meaningful SHORT tokens. So multi-word/long terms keep EXACTLY their previous
 *     significant-word set (e.g. "spray arm" -> ["spray"], "main pcb" -> ["main"]); only all-short
 *     terms gain matchable short tokens.
 *   - wordHit: LONG words (>=4) match by SUBSTRING so inflections still match (heat->heater,
 *     drain->draining). SHORT words (<4) match on WORD BOUNDARIES (optional plural) so they cannot
 *     false-match inside a longer word (gas!=gasket, ice!=service, arm!=warm, fan!=infant).
 *   - termPresent: a term is present when >= min(2, sigWords.length) of its significant words appear.
 *   - No arbitrary DOMAIN_SHORT allowlist is needed — meaningful short terms are handled generally.
 */

const TERM_MATCH_VERSION = 'term-match-v1';

// Function / filler words with NO diagnostic signal. Includes the short function words that a
// naive length>=4 filter used to mask, so a bare function word can never be the sole "significant"
// token of an (all-short) term.
const STOP = new Set([
  'the', 'and', 'for', 'with', 'first', 'clear', 'clean', 'check', 'that', 'this', 'your', 'from', 'into', 'only', 'stage', 'confirm', 'identify', 'rule', 'test', 'does', 'which', 'left', 'not', 'via', 'a', 'an', 'is', 'it', 'to', 'of', 'on', 'in',
  // short function words previously filtered out only because they are < 4 chars:
  'or', 'by', 'at', 'vs', 'are', 'but', 'too', 'any', 'one', 'all', 'so', 'no', 'up', 'us', 'we', 'my', 'me', 'be', 'as', 'if', 'do', 'go', 'off', 'out', 'low',
  // additional filler / check-verb / abbreviation tokens that carry NO diagnostic signal (unioned in
  // from the engineering-challenge runner so significance is judged identically everywhere):
  'reseat', 'wipe', 'improve', 'incl', 'e', 'g', 'still', 'past', 'both', 'also',
]);

/** Lowercase, strip to alphanumerics+spaces, collapse whitespace. */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Reduce a gold/suspect phrase to its essence: drop parentheticals and bracketed notes, then
 *  normalise — so "blocked pump filter (clear first)" and "pump filter" both key to their
 *  significant nouns. (Matches the authoritative ACQ v2 keying: em-dashes are NOT trailer-stripped
 *  because real gold lists components AFTER an em-dash, e.g. "STAGE never heats — element / NTC";
 *  norm turns the em-dash itself into a word boundary.) */
function keyTerms(s) {
  return norm(String(s).replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' '));
}

/** Significant words of a term (see module semantics). */
function sigWords(s) {
  const toks = keyTerms(s).split(' ').filter(Boolean);
  const long = toks.filter((w) => w.length >= 4 && !STOP.has(w));
  if (long.length) return long;
  return toks.filter((w) => !STOP.has(w)); // all-short term -> keep its meaningful short tokens
}

/** Does a single significant word appear in the haystack? Long=substring (inflections); short=word
 *  boundary (optional plural), so short terms cannot false-match inside a longer word. */
function wordHit(w, hay) {
  if (w.length >= 4) return hay.includes(w);
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:es|s)?(?![a-z0-9])`).test(hay);
}

/** A gold term is "present" in a haystack STRING when >= min(2, sig.length) of its significant
 *  words appear. Haystack should be lower-cased by the caller (matches historical usage). */
function termPresent(term, hay) {
  const g = sigWords(term);
  if (!g.length) return false;
  const need = Math.min(2, g.length);
  const h = String(hay || '');
  return g.filter((w) => wordHit(w, h)).length >= need;
}

/** A gold term is present in a LIST of suspect strings when ANY single suspect satisfies termPresent
 *  (i.e. the required significant words appear within the SAME suspect — no cross-suspect scatter).
 *  Each suspect is normalised here (lower-case + punctuation->space), matching the historical
 *  per-element norm() the list-based runners applied. */
function presentInList(term, list) {
  return (Array.isArray(list) ? list : []).some((h) => termPresent(term, norm(String(h == null ? '' : h))));
}

module.exports = { TERM_MATCH_VERSION, STOP, norm, keyTerms, sigWords, wordHit, termPresent, presentInList };
