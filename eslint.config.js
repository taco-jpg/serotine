const js = require('@eslint/js')
const tsParser = require('@typescript-eslint/parser')

module.exports = [
  {
    ignores: ['node_modules', '.next', '.vercel', 'dist', 'build', '.git', 'out', 'eslint.config.js']
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    }
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true
        }
      },
      globals: {
        React: 'readonly',
        JSX: 'readonly',
      }
    },
    rules: {
      'no-unused-vars': 'off',
    }
  }
]
