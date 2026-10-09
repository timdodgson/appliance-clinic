# 0013. Prompt registry and contract types

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

**Prompts.** Ten language-model and Jev prompts shape what customers and S4R see, and what the quality judges score.
They had no identity or version: a wording change was indistinguishable from any other code change.
- Only the transcript review and the two benchmark judges recorded a version.
- The prompts used by every S4R `/part-finder` request had none.

**Contracts.** The contracts that cross runtime boundaries were implicit:
- the `/part-finder` NDJSON frames
- the cs/1 conversation state
- the engine configuration

**Constraints on TypeScript.**
- The two Lambda zips have no build step, and CI requires each to equal the deployed artefact byte for byte.
  Converting sources to TypeScript would add a compile step to two production artefacts and change every file.
- Strict type checking of the existing JavaScript reports thousands of errors in the large modules, so checking it
  wholesale gives no signal.

## Decision

**Prompts are registered, not moved** ([`prompts/registry.json`](../../prompts/registry.json)).
- **Fields:** each prompt has a stable id, an integer version, its purpose, owner and consumers, its input and output
  contract, and a changelog.
- **Source:** a prompt's source is the exact text of named declarations in the runtime code. It stays next to the logic
  that fills it.
- **Fingerprint:** its SHA-256 must equal the latest changelog entry, so changing a prompt fails CI until a version is
  added.
- **Runtime version:** where the runtime stamps a version on its output, the registry records it and the test keeps the
  two equal.
- **Registration:** the Phase 8 split moved the COMPOSE prompts byte for byte; their fingerprints equal those in the
  original file. All prompts are registered at version 1, unchanged.

**TypeScript checks contracts, not the whole codebase.**
- **Declarations:** `types/*.d.ts` declares the boundary contracts under `strict`.
- **Conformance:** `types/check/*.ts` makes `tsc` check the runtime modules against those declarations: cs/1 key sets,
  the engine configuration, the prompt registry.
- **Field coverage:** `types/contract-fields.test.mjs` requires the declared `/part-finder` types to cover every field
  the S4R page reads.
- **New tooling:** new code is written with `// @ts-check` and JSDoc types (`prompts/fingerprint.mjs`).
- **CI:** a `typecheck` job runs `tsc`. No `.ts` source ships in a Lambda zip.

## Consequences

- A prompt change is visible, versioned and reviewable. It still needs evaluating; the registry records that it
  happened, not whether it is better.
- Contract drift between the runtime and its declared shape fails `tsc`. Behaviour inside large modules is not
  type-checked; it remains covered by tests.
- Typing more modules means adding JSDoc and `// @ts-check` one module at a time, smallest first, and only where a
  module is next changed.

## Alternatives considered

- **Move prompts into separate text files.** Rejected for now: it changes both runtime artefacts and the code that
  fills the prompts, for no behaviour gain. The registry gives identity and versioning without moving them.
- **Convert the services to TypeScript.** Rejected: a compile step in two byte-pinned production artefacts, and a
  rewrite of thousands of lines.
- **`checkJs` over all JavaScript.** Rejected: thousands of errors, so no signal.
