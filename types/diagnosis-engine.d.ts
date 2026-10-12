/**
 * The diagnosis engine's internal contract (ADR 0019, ADR 0020): the signed requests whichpart-api sends to
 * `applianceclinic-diagnosis-engine`, and the JSON it returns. Every request carries the AC engine signature over its
 * exact body (ADR 0017); there is no unsigned request. A diagnose request is one ac2 turn (`mode: 'turn'`); any other
 * request that is not feedback or GET /health is refused (400 unsupported_request).
 */

export type Role = 'user' | 'assistant';

export interface TextContent { type: 'text'; text: string }
export interface ImageContent { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: Role;
  content: string | Array<TextContent | ImageContent>;
  /** Media the advisor showed with this reply (assistant turns), so the engine does not show it again. */
  media?: Array<Record<string, unknown>>;
}

/** A fact in the evidence ledger, with its provenance (ac2/ledger.js). */
export interface LedgerFact {
  id: string;
  field: string;
  value: unknown;
  source: 'customer' | 'tool' | 'observation' | 'inference';
  status: 'stated' | 'observed' | 'inferred' | 'uncertain' | 'contradicted';
  turn: number;
  quote?: string | null;
  [extra: string]: unknown;
}

/** The conversation's evidence ledger (ac2/1). whichpart-api stores it (ac2-state.js) and sends it back each turn. */
export interface Ac2State {
  schema: 'ac2/1';
  turn: number;
  appliance: Record<string, unknown> | null;
  brand: Record<string, unknown> | null;
  model: Record<string, unknown> | null;
  codes: Array<Record<string, unknown>>;
  facts: LedgerFact[];
  asked: Array<Record<string, unknown>>;
  hazard: Record<string, unknown> | null;
  scope: Record<string, unknown> | null;
  outcome: Record<string, unknown> | null;
  nextId: number;
  /** Hazards found in the customer's words; they persist for the conversation. */
  hazards?: Array<{ type: string; clause: string; turn: number; shown: boolean }>;
}

/** A strong recall match whichpart-api found for a model the customer named (a tool result for the reasoner). */
export interface RecallHint { title: string; url: string | null; brand: string | null }

/** One customer turn. */
export interface EngineTurnRequest {
  mode: 'turn';
  messages: ChatMessage[];
  ac2?: { state?: Ac2State | null; tools?: { recalls?: RecallHint[] } };
  /** The customer's latest photo (data URL), if any. */
  image?: string;
}

/** A customer's rating of an earlier reply, forwarded by whichpart-api. */
export interface EngineFeedbackRequest {
  feedback: { traceId: string; rating: 'up' | 'down'; note?: string };
}

export type EngineRequest = EngineTurnRequest | EngineFeedbackRequest;

/** A refused or failed request. */
export interface EngineError {
  error: string;
  errorCode: 'engine_signature_required' | 'unsupported_request' | 'reasoner_unavailable' | 'engine_unavailable';
}

export interface Part {
  title: string;
  partNo: string;
  partId: string | number;
  price: number | string | null;
  link: string;
  image?: string | null;
  [extra: string]: unknown;
}

export interface SafetyStop { class: string; stopUse: true; message: string }

/** The customer-facing result of a turn. A safety stop or an out-of-scope reply carries only some of the fields. */
export interface TurnResponse {
  outcome: 'ANSWER' | 'SAFETY_STOP';
  message: string;
  diagnosis?: { summary: string; likelyArea: string | null; confidenceBand: 'likely' | 'possible' } | null;
  suggestedChecks?: string[];
  /** Present only when the part gate verified the part for the customer's confirmed model. */
  parts?: Part[] | null;
  resolvedModel?: string | null;
  modelRequired?: boolean;
  safety?: SafetyStop | null;
  safetyInformation?: { text: string; classification?: string | null } | null;
  media?: Array<Record<string, unknown>> | null;
  codeResult?: { displayed: string; meaning: string | null; recordType: string | null; status: 'RESOLVED' } | null;
  escalation?: { to: string; reason: string; forced?: boolean } | null;
  candidates?: Array<Record<string, unknown>>;
  confidence?: string;
  status?: string;
}

/** The bounded, chain-of-thought-free audit of the turn (ac2/turn.js). */
export interface TurnAudit {
  schema: 'ac2-audit/1';
  turn: number;
  timings: Record<string, number>;
  toolCalls: Array<{ tool: string; results: unknown[] }>;
  safety: { hazards: string[]; gates: Array<Record<string, unknown>>; terminated?: string };
  claims: { rejected: Array<{ claim: string; source: string }>; checked: number };
  regenerated: boolean;
  provider: { name: string | null; model: string | null } | null;
  [extra: string]: unknown;
}

/** The response to a turn (200). */
export interface TurnResult {
  type: 'ac2';
  response: TurnResponse;
  state: Ac2State;
  audit: TurnAudit;
}
