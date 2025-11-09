export default [
  {
    files: ['scripts/**/*.js', 'scripts/**/*.mjs'],
    ignores: ['sdk/**', '**/*.d.ts', 'sdk/js/client.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // Structural guardrails only; avoid style noise
      complexity: ['warn', 60],
      'max-lines': ['warn', { max: 25000, skipBlankLines: true, skipComments: true }],
    },
  },
];
