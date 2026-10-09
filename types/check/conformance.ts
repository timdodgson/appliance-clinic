/**
 * Compile-time checks that the runtime modules still match the declared contracts. Nothing here runs; `tsc` fails
 * when a runtime shape stops fitting its declaration.
 */
import type { ConversationState } from '../canonical';
import type { EngineConfig } from '../engine-config';
import type { PromptRegistry } from '../prompts';
import cs1 = require('../../services/part-finder/canonical/cs1.js');
import engineConfig = require('../../services/part-finder/engine/config.js');
import registry = require('../../prompts/registry.json');

/** True only when A and B have exactly the same keys. */
type SameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never] ? true : false;

// cs/1: JavaScript widens literals (a SafetyLevel reads as string), so the state is checked structurally: the same
// keys at every level the declaration spells out.
type Runtime = ReturnType<typeof cs1.emptyState>;
export const stateKeys: SameKeys<Runtime, ConversationState> = true;
export const identityKeys: SameKeys<Runtime['identity'], ConversationState['identity']> = true;
export const evidenceKeys: SameKeys<Runtime['evidence'], ConversationState['evidence']> = true;
export const safetyKeys: SameKeys<Runtime['safety'], ConversationState['safety']> = true;
export const scopeKeys: SameKeys<Runtime['scope'], ConversationState['scope']> = true;

// The engine configuration and the prompt registry are checked by assignment.
export const config: EngineConfig = engineConfig;
export const prompts: PromptRegistry = registry;
