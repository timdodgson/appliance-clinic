/** The diagnosis engine's configuration module (services/diagnosis-engine/engine/config.js). */
export interface EngineConfig {
  /** S4R Parts Catalogue parts-for-model API (external). Optional; defaults to the production catalogue
   *  (docs/architecture/configuration.md). */
  PARTS_FOR_MODEL_API: string;
  LM_TEMPERATURE: number;
  LM_TIMEOUT_MS: number;
  LM_REPEAT_PENALTY: number;
  MAX_MESSAGES: number;
  MAX_BODY_BYTES: number;
  /** The admin-configured inference providers, cached for AI_CONFIG_CACHE_TTL_MS. */
  getProviders: () => Promise<unknown>;
}
