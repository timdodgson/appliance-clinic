/**
 * Compile-time checks that the runtime modules still match the declared contracts. Nothing here runs; `tsc` fails
 * when a runtime shape stops fitting its declaration.
 */
import type { Ac2State } from '../diagnosis-engine';
import type { EngineConfig } from '../engine-config';
import type { PromptRegistry } from '../prompts';
import ledger = require('../../services/diagnosis-engine/ac2/ledger.js');
import engineConfig = require('../../services/diagnosis-engine/engine/config.js');
import registry = require('../../prompts/registry.json');

/** True only when A and B have exactly the same keys. */
type SameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never] ? true : false;

// ac2/1: JavaScript widens literals (the schema reads as string), so the new ledger is checked structurally: the same
// keys as the declaration, apart from `hazards`, which the turn adds when it first records a hazard.
type Runtime = ReturnType<typeof ledger.empty>;
export const ledgerKeys: SameKeys<Runtime, Omit<Ac2State, 'hazards'>> = true;

// The engine configuration and the prompt registry are checked by assignment.
export const config: EngineConfig = engineConfig;
export const prompts: PromptRegistry = registry;
