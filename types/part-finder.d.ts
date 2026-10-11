/**
 * The diagnosis engine's public contract: the request the S4R /part-finder page and the orchestrator send to the
 * Function URL, and the NDJSON frames it streams back. The fields the S4R page reads are listed in
 * tools/migration/config/baseline.json (partFinderContract) and checked by types/contract-fields.test.mjs.
 */

export type Role = 'user' | 'assistant';

export interface TextContent { type: 'text'; text: string }
export interface ImageContent { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: Role;
  content: string | Array<TextContent | ImageContent>;
}

/** What the S4R page sends: the conversation only. That always runs the legacy pipeline (ADR 0012). */
export interface PartFinderRequest {
  messages: ChatMessage[];
}

/**
 * What the orchestrator adds. These fields are honoured only with a valid HMAC signature over the exact body
 * (ADR 0017); without one they are dropped and the request is plain `{messages}`.
 */
export interface OrchestratorPartFinderRequest extends PartFinderRequest {
  mode?: 'understand';
  understand?: Record<string, unknown>;
  canonical?: Record<string, unknown>;
  seed?: number;
}

export interface DeltaFrame { type: 'delta'; text: string }

export interface ErrorFrame { type: 'error'; error: string }

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

/** One line of the NDJSON stream: deltas, then exactly one done (or an error once streaming has started). */
export type PartFinderFrame = DeltaFrame | DoneFrame | ErrorFrame;

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

/** Understand-mode response (orchestrator only; S4R never sends `mode`). */
export interface UnderstandFrame {
  type: 'understand';
  understand: Record<string, unknown> & { tokenDecision?: TokenDecision };
  jev: Record<string, unknown>;
  canonical?: Record<string, unknown>;
}

