const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  // Ignore generated or external folders
  {
    ignores: ['node_modules/**', 'dist/**'],
  },
  // Base JS config for the whole project (Node + ESM)
  {
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Start from the recommended browser/ES globals
        ...(js.configs.recommended.languageOptions?.globals || {}),
        // Add Node built-ins like process, Buffer, __dirname, etc.
        ...globals.node,
      },
    },
    rules: {
      // Honor the `_`-prefix convention for intentional throwaways, and ignore
      // destructure siblings that only exist to omit keys from a rest spread
      // (e.g. `const { sets, ...rest } = overrides`).
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // Test files (Vitest) – allow common test globals
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
      },
    },
  },
];
