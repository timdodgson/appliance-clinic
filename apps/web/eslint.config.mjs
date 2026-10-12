import js from '@eslint/js';
import globals from 'globals';

// Browser code is classic scripts (no bundler): each file is an IIFE or a UMD module that also loads in Node for
// tests. Build, serve and deploy helpers are Node ES modules.
export default [
  { ignores: ['node_modules/**', 'dist/**'] },
  js.configs.recommended,
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: { ...globals.browser, module: 'readonly', define: 'readonly', global: 'readonly' },
    },
    // ES5-style code: `catch (e) {}` is the house idiom for best-effort browser APIs (storage, clipboard).
    rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }], 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  { files: ['public/sw.js'], languageOptions: { globals: { ...globals.serviceworker } } },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.mjs', '*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
];
