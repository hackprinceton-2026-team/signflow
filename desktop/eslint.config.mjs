import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'node_modules/**',
      'test-results/**',
      'src/renderer/src/contract/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'e2e/**/*.ts', 'contract/**/*.{ts,mts}', '*.config.{mts,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name='nodeIntegration'][value.value=true]",
          message: 'nodeIntegration must stay disabled.',
        },
        {
          selector: "Property[key.name='contextIsolation'][value.value=false]",
          message: 'contextIsolation must stay enabled.',
        },
        {
          selector: "Property[key.name='sandbox'][value.value=false]",
          message: 'sandbox must stay enabled.',
        },
        {
          selector: "Property[key.name='webSecurity'][value.value=false]",
          message: 'webSecurity must stay enabled.',
        },
      ],
    },
  },
);
