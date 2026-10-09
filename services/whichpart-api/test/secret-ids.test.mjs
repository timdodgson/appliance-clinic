/**
 * Phase 7 (D): the AI-config, OpenAI and Jev secret ids follow the environment (the AC namespace), and default to the
 * original ids when it is not set.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const path = require.resolve('../ai-config.js');
const KEYS = ['AI_CONFIG_SECRET_ID', 'OPENAI_SECRET_ID', 'JEV_SECRET_ID', 'STAGE'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const fresh = () => { delete require.cache[path]; return require(path); };

afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } delete require.cache[path]; });

describe('secret ids', () => {
  it('default to the original ids', () => {
    for (const k of KEYS) delete process.env[k];
    const m = fresh();
    expect([m.AI_CONFIG_SECRET_ID, m.OPENAI_SECRET_ID, m.JEV_SECRET_ID]).toEqual([
      'spares4repairs/dev/applianceclinic-ai-config', 'spares4repairs/dev/applianceclinic-openai', 'spares4repairs/dev/applianceclinic-jev']);
  });
  it('follow the environment when set', () => {
    process.env.AI_CONFIG_SECRET_ID = 'applianceclinic/production/ai-config';
    process.env.OPENAI_SECRET_ID = 'applianceclinic/production/openai';
    process.env.JEV_SECRET_ID = 'applianceclinic/production/jev';
    const m = fresh();
    expect([m.AI_CONFIG_SECRET_ID, m.OPENAI_SECRET_ID, m.JEV_SECRET_ID]).toEqual([
      'applianceclinic/production/ai-config', 'applianceclinic/production/openai', 'applianceclinic/production/jev']);
  });
  it('an empty variable falls back to the original id', () => {
    process.env.AI_CONFIG_SECRET_ID = '';
    delete process.env.STAGE;
    expect(fresh().AI_CONFIG_SECRET_ID).toBe('spares4repairs/dev/applianceclinic-ai-config');
  });
});
