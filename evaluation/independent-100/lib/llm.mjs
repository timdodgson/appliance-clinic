// Calls a Claude model through the Claude Code CLI in an isolated, tool-less, repository-less session (no API key is
// available in the benchmark environment). Used for the general assistant (system B), the customer simulator and the
// judges. None of these is part of Appliance Clinic production, and none sees AC's code, prompts or traces.
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const SANDBOX = process.env.BENCH_SANDBOX || '/tmp/ga-sandbox';
mkdirSync(SANDBOX, { recursive: true });

/**
 * @param {{ model: string, system: string, prompt: string, sessionId?: string, resume?: boolean, persist?: boolean, timeoutMs?: number }} o
 * @returns {Promise<{ text: string, costUsd: number, ms: number }>}
 */
export function claude({ model, system, prompt, sessionId, resume = false, persist = false, timeoutMs = 300000 }) {
  const args = ['-p', '--system-prompt', system, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--model', model, '--output-format', 'json'];
  if (sessionId) args.push(resume ? '--resume' : '--session-id', sessionId);
  else if (!persist) args.push('--no-session-persistence');
  args.push(prompt);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    execFile('claude', args, { cwd: SANDBOX, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`claude ${model} failed: ${err.message} ${String(stderr).slice(0, 300)}`));
      let d; try { d = JSON.parse(stdout); } catch { return reject(new Error(`claude ${model}: non-JSON output ${String(stdout).slice(0, 200)}`)); }
      if (d.is_error) return reject(new Error(`claude ${model}: ${String(d.result).slice(0, 300)}`));
      resolve({ text: String(d.result || ''), costUsd: Number(d.total_cost_usd || 0), ms: Date.now() - t0 });
    });
  });
}

/** Retry once on a transient CLI failure (never more: cost control). */
export async function claudeOnce(o) {
  try { return await claude(o); } catch (e) { await new Promise((r) => setTimeout(r, 5000)); return claude(o); }
}

/** First complete JSON object in a model reply (balanced braces, strings respected). */
export function parseJson(text) {
  const s = text.indexOf('{');
  if (s < 0) throw new Error(`no JSON in: ${text.slice(0, 200)}`);
  let depth = 0; let inStr = false; let esc = false;
  for (let i = s; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return JSON.parse(text.slice(s, i + 1)); }
  }
  // fall back to the outermost braces (a reply that is complete but has an unescaped quote inside a string)
  const e = text.lastIndexOf('}');
  if (e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch { /* below */ } }
  throw new Error(`unbalanced JSON in: ${text.slice(0, 200)}`);
}
