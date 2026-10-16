# Code audit of the live customer turn (2026-10-16) — working notes

Trigger: live chat "Dyson V6 Pulising" → "filter is blocked" → "the filter is actually damaged" gave a bad answer.
Method: read every file on the path, in order; each finding cites file:line and, where possible, data (live logs,
the 100-case Opus run audits).

## Path
browser app.js → whichpart-api index.js (diagnose) → ac2-turn.js → engine handler.js → ac2/runtime.js → ac2/turn.js

## Findings (as read)
- whichpart-api/index.js:609 sanitizeReply strips markdown bold, links, bullets.
- engine handler.js:65 passes `image` to ac2.turn; ac2/runtime.js:44 `turn({messages,state,tools})` drops it; turn.js
  never reads input.image. Customer photos are never used.
- turn.js decide() stage 1 (line 233): instructs "give the safe checks ... usually two to four" → multi-check walls of
  text by design; and "Do not tell them to buy, order or replace a part yet".
- turn.js:107-108 stage 2 only when Jev labels checkOutcome still_faulty (+ a Jev-confirmed check) or Jev labels
  `narrowed`. Parts lookup (449) needs stage 2 AND narrowed AND a model. Dyson chat: stage stayed 1.
- turn.js:604 response.diagnosis "Likely cause: <rec.narrowed.component>" — shown as a heading each turn once Jev
  labels `narrowed` (VC-02: "Likely cause: battery — flat or failed" while the fault was the filter).
- Post-processing chain after the model writes (turn.js 522-570): claim check (sentence removal) → gateReply
  (prohibited advice; collapses whitespace incl. paragraph breaks) → unsafe-reassurance → calibrate (rewrites
  certainty words) → removeUnconfirmedAdvice (drops buy/replace sentences unless narrowed) → removeUnverifiedIdentifiers
  → hazard/step-precaution prefix joined with a space.
- turn.js:568 stepPrecaution prepends "Switch it off and unplug it (or take the battery off) first." to vacuum replies
  with a physical step (Dyson turn 1 opened with it).
- Experiments still wired in turn.js (jev-led, jev-evidence, jevChooses): off in live config.
