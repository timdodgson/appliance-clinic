// Vitest configuration for the imported runtime tests (Phase 3, #29), and the prompt registry, contract types and
// configuration checks (Phase 8). Scoped to services/, prompts/, types/ and build/test/ so a file filter never matches
// copies elsewhere, such as local .migration-output/ exports.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['services/**/*.test.{js,mjs,cjs}', 'prompts/**/*.test.mjs', 'types/**/*.test.mjs', 'build/test/**/*.test.mjs'],
    exclude: ['**/node_modules/**', '.migration-output/**'],
  },
});
