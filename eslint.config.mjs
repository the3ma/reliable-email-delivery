import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'infra/**', 'templates/**'],
  },
  {
    files: ['**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': 'error',
    },
  },
  {
    files: ['packages/functions/src/cli/**/*.ts', 'packages/*/test/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // A dynamic import of a CommonJS package (the AWS SDK) loses its named exports in the ESM
    // bundle ('SQSClient is not a constructor'); only our own modules may be imported lazily.
    files: ['packages/*/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression[source.value=/^[^.]/]',
          message: 'Import packages statically; dynamic import() is only for relative modules.',
        },
      ],
    },
  },
  prettier,
);
