import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * レイヤー境界（docs/07_architecture.md）:
 *   core   … DOM・描画・UI・実時間・Math.random に依存しない
 *   editor … 編集状態（core を使う）。UI・描画に依存しない
 *   render / ui … editor・core を使う。互いに依存しない
 */
const restrict = (patterns) => ['error', { patterns }];

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'test-results', 'playwright-report'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': restrict([
        { group: ['**/editor/**', '**/render/**', '**/ui/**', '**/i18n/**', '**/app/**'], message: 'core は上位レイヤーに依存できません' },
        { group: ['react', 'react-dom', 'pixi.js', 'zustand', 'zustand/*'], message: 'core は UI・描画ライブラリに依存できません' },
      ]),
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: '再現性のため core/rng.ts のシード付き乱数を使ってください' },
        { object: 'Date', property: 'now', message: 'core は実時間に依存できません' },
        { object: 'performance', property: 'now', message: 'core は実時間に依存できません' },
      ],
      'no-restricted-globals': ['error', 'window', 'document', 'localStorage'],
    },
  },
  {
    files: ['src/editor/**/*.ts'],
    rules: {
      'no-restricted-imports': restrict([
        { group: ['**/render/**', '**/ui/**', '**/app/**', 'pixi.js'], message: 'editor は UI・描画に依存できません' },
      ]),
    },
  },
  {
    files: ['src/render/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': restrict([{ group: ['**/ui/**'], message: 'render と ui は互いに依存できません' }]) },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': restrict([
        { group: ['**/render/*', '!**/render/MapView'], message: 'ui は MapView 以外の描画モジュールに依存できません' },
        { group: ['pixi.js'], message: 'ui は描画ライブラリに依存できません' },
      ]),
    },
  },
);
