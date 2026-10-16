/**
 * The diagnosis engine's internal contract (ADR 0019, ADR 0023): the signed requests whichpart-api sends to
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

/** A hazard the customer's words raised; it stays active for the rest of the chat unless they later deny it. */
export interface Hazard {
  type: string;
  clause: string;
  turn: number;
  /** The fixed warning has been shown to the customer. */
  shown: boolean;
  cleared?: boolean;
  clearedTurn?: number;
  [extra: string]: unknown;
}

/**
 * The conversation record (ac3/1): what the engine keeps between turns. whichpart-api stores it (ac2-state.js) and
 * sends it back each turn (`ac2/record.js`). The advisor reads the conversation itself; the record holds only what
 * must survive a turn: the appliance identity the advisor learnt, the active hazards and the advisor's outcome.
 */
export interface ConversationRecord {
  schema: 'ac3/1';
  turn: number;
  customer: { appliance: string | null; brand: string | null; model: string | null };
  hazards: Hazard[];
  outcome: 'diagnosing' | 'part_needed' | 'engineer' | 'normal' | 'fixed' | 'out_of_scope' | 'safety_stop' | null;
}

/** A strong recall match whichpart-api found for a model the customer named (a note for the advisor). */
export interface RecallHint { title: string; url: string | null; brand: string | null }

/** One customer turn. */
export interface EngineTurnRequest {
  mode: 'turn';
  messages: ChatMessage[];
  ac2?: { state?: ConversationRecord | null; tools?: { recalls?: RecallHint[] } };
}

/** A customer's rating of an earlier reply, forwarded by whichpart-api. */
export interface EngineFeedbackRequest {
  feedback: { traceId: string; rating: 'up' | 'down'; note?: string };
}

export type EngineRequest = EngineTurnRequest | EngineFeedbackRequest;

/** A refused or failed request. `reasoner_unavailable` is the historical code for "the advisor could not run". */
export interface EngineError {
  error: string;
  errorCode: 'engine_signature_required' | 'unsupported_request' | 'reasoner_unavailable' | 'engine_unavailable';
}

/** A catalogue part (engine/parts-client.js), verified for the customer's model by find_parts. */
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

export interface Escalation { to: string; reason: string; forced?: boolean }

/** The customer-facing result of a turn (`ac2/turn.js`). A safety stop carries only the message, safety and escalation. */
export interface TurnResponse {
  outcome: 'ANSWER' | 'SAFETY_STOP';
  message: string;
  /** Present only when the catalogue lists the part for the customer's model (find_parts). */
  parts?: Part[] | null;
  resolvedModel?: string | null;
  safety?: SafetyStop | null;
  safetyInformation?: { text: string; classification?: string | null } | null;
  media?: Array<Record<string, unknown>> | null;
  escalation?: Escalation | null;
}

/** A fixed safety check that changed or held the reply. */
export interface SafetyGate { gate: string; [detail: string]: unknown }

/**
 * The bounded audit of the turn (`ac2/turn.js`): timings, token usage, the tools the advisor called, the safety gates
 * that fired, the part decision, escalation and this turn's tags. No customer text, no model reasoning.
 */
export interface TurnAudit {
  schema: 'ac4-audit/1';
  turn: number;
  timings: Record<string, number>;
  provider: { name: string | null; model: string | null } | null;
  safety: { hazards: string[]; gates: SafetyGate[]; terminated?: string };
  usage?: Record<string, number> | null;
  toolCalls?: string[];
  partGate?: { outcome: 'verified' | 'no_catalogue_part' | 'none'; component: string | null; reason: string | null };
  escalation?: Escalation | null;
  tags?: { outcome: string | null; media: string | null; enrichment: { knowledgeIds: string[]; codes: Array<Record<string, unknown>>; recalls: number; parts: number } };
  [extra: string]: unknown;
}

/** The response to a turn (200). */
export interface TurnResult {
  type: 'ac2';
  response: TurnResponse;
  state: ConversationRecord;
  audit: TurnAudit;
}
