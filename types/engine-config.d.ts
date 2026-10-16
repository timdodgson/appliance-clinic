/** The diagnosis engine's configuration module (services/diagnosis-engine/engine/config.js). */
export interface EngineConfig {
  /** S4R Parts Catalogue parts-for-model API (external). Optional; defaults to the production catalogue
   *  (docs/architecture/configuration.md). */
  PARTS_FOR_MODEL_API: string;
  MAX_MESSAGES: number;
  MAX_BODY_BYTES: number;
  /** The advisor's provider (the admin-configured model and credential), cached for AI_CONFIG_CACHE_TTL_MS. */
  getAdvisorProvider: () => Promise<unknown>;
  /** Tests only: replace the cached provider. */
  _setProviderForTest: (provider: unknown) => void;
}
