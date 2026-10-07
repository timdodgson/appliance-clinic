// Vitest configuration for the imported runtime tests (Phase 3, #29). Scoped to services/ so a
// file filter never matches copies elsewhere, such as local .migration-output/ exports.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['services/**/*.test.{js,mjs,cjs}'],
    exclude: ['**/node_modules/**', '.migration-output/**'],
  },
});
