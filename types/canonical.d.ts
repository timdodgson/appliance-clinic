/**
 * cs/1: the canonical cumulative conversation state (services/part-finder/canonical/cs1.js). Persisted by
 * whichpart-api, carried between turns as an opaque signed token, merged by a pure function, never written by the
 * language model.
 */

export type SafetyLevel =
  | 'NORMAL_DIAGNOSTIC' | 'STATUS_ONLY' | 'SERVICE_REQUIRED' | 'ISOLATE_IF_SAFE' | 'STOP_USE' | 'EMERGENCY_ACTION';

export interface FactHistoryEntry<T> { value: T; basis: string | null; turn: number | null; supersededBy?: unknown }

/** A Fact<T>: a value with its basis and the turn that established it. */
export interface Fact<T> {
  value: T | null;
  basis: string | null;
  turn: number | null;
  status: string;
  history: Array<FactHistoryEntry<T>>;
}

export interface ConversationState {
  schemaVersion: string;
  sessionId: string | null;
  version: number;
  scope: { lastRequestClass: string | null; refusals: number };
  identity: {
    appliance: Fact<string>;
    applianceEstablishment: string;
    make: Fact<string>;
    model: Fact<string> & { confirmed: boolean };
    modelStatus: 'known' | 'unavailable' | 'pending_lookup' | null;
    fuel: Fact<string> & { conflict: boolean };
    displayedCodes: Array<Fact<string>>;
  };
  intent: { active: string | null; history: unknown[] };
  problems: Array<{ id: string; status: string; [k: string]: unknown }>;
  evidence: {
    observations: Record<string, Fact<boolean>>;
    checks: Record<string, { status: string; result: unknown; turn: number | null; history: unknown[] }>;
    replacedParts: unknown[];
    customerTheories: unknown[];
  };
  declined: unknown[];
  safety: {
    hazards: unknown[];
    activeLevel: SafetyLevel;
    peakLevel: SafetyLevel;
    unsafeActions: unknown[];
  };
  resolution: 'unresolved' | 'resolved' | 'temporary' | null;
  requests: unknown[];
  pendingRequest: string | null;
  inferred: Record<string, unknown>;
}
