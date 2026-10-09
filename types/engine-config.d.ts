/** The diagnosis engine's configuration module (services/part-finder/engine/config.js). */
export interface EngineConfig {
  /** S4R catalogue search API. Optional; defaults to the production S4R API (docs/architecture/configuration.md). */
  SEARCH_API: string;
  /** S4R parts-for-model API. Optional; defaults to the production S4R API. */
  PARTS_FOR_MODEL_API: string;
  LM_TEMPERATURE: number;
  LM_MAX_TOKENS: number;
  LM_TIMEOUT_MS: number;
  LM_REPEAT_PENALTY: number;
  MAX_MESSAGES: number;
  MAX_BODY_BYTES: number;
  /** The admin-configured inference providers, cached for AI_CONFIG_CACHE_TTL_MS. */
  getProviders: () => Promise<unknown>;
}
