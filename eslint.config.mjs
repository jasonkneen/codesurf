import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const recommendedSafetyRules = Object.fromEntries(
  [
    'constructor-super',
    'for-direction',
    'getter-return',
    'no-async-promise-executor',
    'no-class-assign',
    'no-compare-neg-zero',
    'no-const-assign',
    'no-constant-binary-expression',
    'no-debugger',
    'no-dupe-args',
    'no-dupe-else-if',
    'no-dupe-keys',
    'no-duplicate-case',
    'no-empty-character-class',
    'no-ex-assign',
    'no-extra-boolean-cast',
    'no-func-assign',
    'no-import-assign',
    'no-invalid-regexp',
    'no-loss-of-precision',
    'no-new-native-nonconstructor',
    'no-obj-calls',
    'no-self-assign',
    'no-setter-return',
    'no-shadow-restricted-names',
    'no-sparse-arrays',
    'no-this-before-super',
    'no-unreachable',
    'no-unreachable-loop',
    'no-unsafe-finally',
    'no-unsafe-negation',
    'no-unsafe-optional-chaining',
    'no-unused-labels',
    'no-unused-private-class-members',
    'no-useless-backreference',
    'no-useless-catch',
    'no-with',
    'require-yield',
    'use-isnan',
    'valid-typeof',
  ].map((ruleName) => [ruleName, js.configs.recommended.rules[ruleName] ?? 'error']),
)

const sharedLanguageOptions = {
  ecmaVersion: 'latest',
  globals: {
    ...globals.browser,
    ...globals.node,
    ...globals.worker,
  },
  sourceType: 'module',
}

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-electron/**',
      '**/zig-out/**',
      '**/vendor/**',
      '.claude/worktrees/**',
      '.tmp/**',
      'build-electrobun/**',
      'coverage/**',
      'desktop/.native-sidecar/**',
      'desktop/.zig-cache/**',
      'desktop/frontend/**',
      'electrobun/build/**',
      'out/**',
      'playwright-report/**',
      'release/**',
      'src/renderer/public/**',
      'src/renderer/src/assets/cluso/**',
      'test-results/**',
      // Vite dep-optimizer caches: generated third-party bundles whose embedded
      // eslint-disable comments reference rules this config doesn't define.
      '.vite/**',
      '**/.vite/**',
    ],
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: sharedLanguageOptions,
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: recommendedSafetyRules,
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ...sharedLanguageOptions,
      parser: tseslint.parser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      ...recommendedSafetyRules,
      'react-hooks/rules-of-hooks': 'error',
    },
  },
]
