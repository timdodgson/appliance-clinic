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

/** A labelled customer value: what Jev judged from the customer's own words, with its confidence. */
export interface LabelledValue { value: string; confidence: number | null; turn: number }

/** The conversation record (ac3/1). whichpart-api stores it (ac2-state.js) and sends it back each turn. */
export interface ConversationRecord {
  schema: 'ac3/1';
  turn: number;
  /** What the customer told us. */
  customer: {
    appliance: LabelledValue | null;
    brand: LabelledValue | null;
    model: LabelledValue | null;
    codes: Array<{ code: string; turn: number }>;
    symptom: LabelledValue | null;
    symptomArea: LabelledValue | null;
    checks: Array<{ check: string; result: string; turn: number }>;
    modelUnavailable: boolean;
  };
  /** What our tools added, kept apart from customer facts. */
  knowledge: { knowledgeIds: string[]; fault: string | null; causes: string[]; components: string[]; codeMeanings: Array<Record<string, unknown>>; modelInfo: Array<Record<string, unknown>> };
  asked: Array<{ question: string; turn: number; answer: string | null }>;
  hazards: Array<{ type: string; clause: string; turn: number; shown: boolean; [extra: string]: unknown }>;
  /** 1 = broad help and safe checks; 2 = the owner's checks failed: narrow, model, part. */
  stage: 1 | 2;
  narrowed: { component: string; confidence: number | null; turn: number } | null;
  outcome: 'fixed' | 'part' | 'engineer' | 'normal' | 'safety_stop' | null;
}

/** A strong recall match whichpart-api found for a model the customer named (a tool result for the reasoner). */
export interface RecallHint { title: string; url: string | null; brand: string | null }

/** One customer turn. */
export interface EngineTurnRequest {
  mode: 'turn';
  messages: ChatMessage[];
  ac2?: { state?: ConversationRecord | null; tools?: { recalls?: RecallHint[] } };
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

/** The bounded audit of the turn (ac2/turn.js): timings, safety, part decision, the plan and this turn's tags. */
export interface TurnAudit {
  schema: 'ac3-audit/1';
  turn: number;
  timings: Record<string, number>;
  safety: { hazards: string[]; gates: Array<Record<string, unknown>>; terminated?: string };
  provider: { name: string | null; model: string | null } | null;
  tags?: Record<string, unknown>;
  plan?: string[];
  [extra: string]: unknown;
}

/** The response to a turn (200). */
export interface TurnResult {
  type: 'ac2';
  response: TurnResponse;
  state: ConversationRecord;
  audit: TurnAudit;
}
