/**
 * The admin AI configuration and the model credential (admin-config.js): read from Secrets Manager, cached, never
 * logged. Offline: an injectable fetchSecret, so no real secret is read.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadAdminInference, _resetCache, AI_CONFIG_SECRET_ID, OPENAI_SECRET_ID } = require('../admin-config.js');

// A fetchSecret backed by an in-memory map keyed by secret id.
function fakeSecrets({ config, credential } = {}) {
  return async (id) => {
    if (id === AI_CONFIG_SECRET_ID) return config === undefined ? null : JSON.stringify(config);
    if (id === OPENAI_SECRET_ID) return credential === undefined ? null : JSON.stringify(credential);
    return null;
  };
}

describe('loadAdminInference', () => {
  it('returns the configuration document and the anthropicApiKey field of the credential secret, and nothing else', async () => {
    _resetCache();
    const r = await loadAdminInference({ now: 1, fetchSecret: fakeSecrets({ config: { model: 'claude-opus-5-5', version: 3 }, credential: { apiKey: 'sk-openai', anthropicApiKey: 'sk-ant' } }) });
    expect(Object.keys(r).sort()).toEqual(['anthropicKey', 'at', 'config']);
    expect(r.config).toEqual({ model: 'claude-opus-5-5', version: 3 });
    expect(r.anthropicKey).toBe('sk-ant');
  });

  it('absent or unreadable secrets give null (the provider resolution then fails explicitly)', async () => {
    _resetCache();
    const r = await loadAdminInference({ now: 1, fetchSecret: fakeSecrets({}) });
    expect(r).toMatchObject({ config: null, anthropicKey: null });
    _resetCache();
    const bad = await loadAdminInference({ now: 1, fetchSecret: async () => 'not json' });
    expect(bad).toMatchObject({ config: null, anthropicKey: null });
    _resetCache();
    const openaiOnly = await loadAdminInference({ now: 1, fetchSecret: fakeSecrets({ config: { model: 'm' }, credential: { apiKey: 'sk-openai' } }) });
    expect(openaiOnly.anthropicKey).toBe(null);
  });

  it('caches within the TTL and re-reads after it', async () => {
    _resetCache();
    let reads = 0;
    const fetchSecret = async () => { reads++; return JSON.stringify({ model: 'm' }); };
    await loadAdminInference({ now: 1000, fetchSecret });
    await loadAdminInference({ now: 1000 + 30000, fetchSecret }); // within 60s TTL
    expect(reads).toBe(2); // the configuration and the credential, once each
    await loadAdminInference({ now: 1000 + 120000, fetchSecret }); // past TTL
    expect(reads).toBe(4);
    _resetCache();
  });
});
