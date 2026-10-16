/**
 * Compile-time checks that the runtime modules still match the declared contracts. Nothing here runs; `tsc` fails
 * when a runtime shape stops fitting its declaration.
 */
import type { ConversationRecord } from '../diagnosis-engine';
import type { EngineConfig } from '../engine-config';
import type { PromptRegistry } from '../prompts';
import record = require('../../services/diagnosis-engine/ac2/record.js');
import engineConfig = require('../../services/diagnosis-engine/engine/config.js');
import registry = require('../../prompts/registry.json');

/** True only when A and B have exactly the same keys. */
type SameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never] ? true : false;

// ac3/1: JavaScript widens literals (the schema reads as string), so the record is checked structurally: the same
// keys as the declaration, at the top level and in `customer`.
type Runtime = ReturnType<typeof record.empty>;
export const recordKeys: SameKeys<Runtime, ConversationRecord> = true;
export const customerKeys: SameKeys<Runtime['customer'], ConversationRecord['customer']> = true;

// The engine configuration and the prompt registry are checked by assignment.
export const config: EngineConfig = engineConfig;
export const prompts: PromptRegistry = registry;
