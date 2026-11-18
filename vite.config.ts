/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { chunkSizeWarningLimit: 1500 },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    // カバレッジ計測（5-10）: `npm run test:coverage` で計測する。目標は docs/08 の core 80%。
    // 計測していない状態を達成扱いにしないため、しきい値で落とすのではなく数値を出すところまでを導入範囲とする
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts'],
      reporter: ['text-summary'],
    },
  },
});
