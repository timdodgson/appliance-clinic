/**
 * The diagnosis engine's internal contract (ADR 0019): the signed requests Appliance Clinic services send to
 * `applianceclinic-diagnosis-engine`, and the JSON lines it returns. Every request carries the AC engine signature over
 * its exact body (ADR 0017); there is no unsigned request.
 */

export type Role = 'user' | 'assistant';

export interface TextContent { type: 'text'; text: string }
export interface ImageContent { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: Role;
  content: string | Array<TextContent | ImageContent>;
}

/** A diagnosis request from the orchestrator. Without `mode`, the turn is answered only by the canonical journey that
 *  controls it (`canonical`); any other diagnose call is refused (409 canonical_not_controlled, ADR 0018). */
export interface EngineRequest {
  messages: ChatMessage[];
  mode?: 'understand';
  understand?: Record<string, unknown>;
  canonical?: Record<string, unknown>;
  established?: Record<string, unknown>;
  seed?: number;
}

/** A customer's rating of an earlier reply, forwarded by whichpart-api. */
export interface EngineFeedbackRequest {
  feedback: { traceId: string; rating: 'up' | 'down'; note?: string };
}

/** A refused or failed request. */
export interface EngineError {
  error: string;
  errorCode: 'engine_signature_required' | 'canonical_not_controlled' | 'engine_unavailable';
}

export interface DeltaFrame { type: 'delta'; text: string }

export interface Part {
  title: string;
  partNo: string;
  partId: string | number;
  price: number | string | null;
  link: string;
  image?: string | null;
  [extra: string]: unknown;
}

export interface Understood {
  make: string | null;
  appliance: string | null;
  model: string | null;
  fault: string | null;
  code: string | null;
  faultId?: string | null;
  confidence?: number | string | null;
  grounded?: boolean;
  alternatives?: unknown[];
  candidateComponents?: unknown[];
  clarifyingQuestion?: string | null;
  componentMention?: string | null;
  customerEvidence?: unknown;
  customerTheories?: unknown[];
  evidence?: unknown;
  facts?: unknown[];
  knowledgeIds?: string[];
  mediaConcepts?: string[];
  nextBestCheck?: string | null;
  primaryFinding?: string | null;
  primaryFindingKind?: string | null;
  purchaseAppropriate?: boolean;
  onTopic?: boolean;
}

export type SafetyStop = 'gas' | 'shock' | null;

export interface DoneFrame {
  type: 'done';
  traceId: string;
  parts: Part[];
  understood: Understood;
  safetyInformation: unknown | null;
  safetyStop: SafetyStop;
  isolationAdvisory: boolean;
  unsafeIntent: boolean;
  normalBehaviour: boolean;
  media: unknown[];
  componentMention: string;
  purchaseAppropriate: boolean;
  remoteActionClass: string | null;
  diagnosticTrace: unknown;
}

/** The lines of a canonical reply: one delta (the COMPOSE wording), then exactly one done. */
export type EngineReplyLine = DeltaFrame | DoneFrame;

/**
 * The engine's code-or-model commit decision for this turn's identifier token (canonical/token-gate.js, the only
 * implementation of the rule). `uncertain`: a model reading too weak to commit; the token must be confirmed by the
 * customer. `commit`: anything else (including no token, a code reading, or no probability distribution).
 */
export interface TokenDecision {
  meaning: string | null;
  decision: 'commit' | 'uncertain';
  reason: 'not_gated' | 'strong' | 'weak_or_near_tie' | 'meaning_uncertain';
  /** The token the customer is asked about, when the decision is 'uncertain'. */
  token?: string | null;
}

/** The understand-mode response line. */
export interface UnderstandFrame {
  type: 'understand';
  understand: Record<string, unknown> & { tokenDecision?: TokenDecision };
  jev: Record<string, unknown>;
  canonical?: Record<string, unknown>;
}

