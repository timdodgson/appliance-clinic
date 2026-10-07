'use strict';
/**
 * Read-after-write verification for configuration stored in AWS Secrets Manager.
 *
 * Secrets Manager reads are eventually consistent: straight after a successful PutSecretValue a read
 * can still return the PREVIOUS version (observed live on 2026-10-05, run
 * acq-2026-10-05T21-09-47-534Z-5rpiw4tg, where it produced a false conflict). Secrets Manager has no
 * conditional put, so the read-back is also how a concurrent writer is detected. One rule serves both:
 *
 *   read returns the EXPECTED revision          -> verified
 *   read returns the exact PRIOR revision        -> not visible yet: re-read (bounded)
 *   read returns any OTHER revision              -> conflict, immediately (never waited out)
 *   read fails / returns nothing                 -> re-read (bounded)
 * After the bounded window:
 *   last read still showed the prior revision    -> not_visible  (the write was accepted but never observed)
 *   every read failed                            -> read_failed
 *
 * Used by benchmark/routing-override.js (batch override apply/restore/resolve) and settings-admin.js
 * (Settings Apply for diagnostic inference and Jev). Pure: the reader, revision function and sleep
 * are injected.
 */

const DEFAULT_ATTEMPTS = 8;
const DEFAULT_DELAY_MS = 750;

/**
 * @param {object} o
 * @param {() => Promise<any>} o.read          returns the stored document, or null when it cannot be read
 * @param {(doc:any) => string} o.revisionOf   content revision of a document
 * @param {string} o.expectedRevision          revision of the document just written
 * @param {string} o.priorRevision             revision of the document that write replaced
 * @returns {Promise<{status:'verified'|'conflict'|'not_visible'|'read_failed', doc:any, revision:string|null, reads:number}>}
 */
async function readBackAfterWrite({ read, revisionOf, expectedRevision, priorRevision, attempts = DEFAULT_ATTEMPTS, delayMs = DEFAULT_DELAY_MS, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const n = Number.isInteger(attempts) && attempts > 0 ? attempts : DEFAULT_ATTEMPTS;
  let doc = null; let rev = null; let sawPrior = false; let reads = 0;
  for (let i = 0; i < n; i++) {
    reads++;
    try { doc = await read(); } catch { doc = null; }
    rev = doc != null ? revisionOf(doc) : null;
    if (rev != null && rev === expectedRevision) return { status: 'verified', doc, revision: rev, reads };
    if (rev != null && rev !== priorRevision) return { status: 'conflict', doc, revision: rev, reads };
    if (rev != null) sawPrior = true;
    if (i < n - 1) await wait(delayMs);
  }
  return { status: sawPrior || rev != null ? 'not_visible' : 'read_failed', doc, revision: rev, reads };
}

module.exports = { readBackAfterWrite, DEFAULT_ATTEMPTS, DEFAULT_DELAY_MS };
