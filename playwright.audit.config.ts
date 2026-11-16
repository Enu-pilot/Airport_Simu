import { defineConfig } from '@playwright/test';

/**
 * 監査用のブラウザテスト（docs/39_comprehensive_test_audit_and_handover.md）。通常の `npm run test:e2e` には含めない。
 *   npx playwright test -c playwright.audit.config.ts --trace off                … 合格する監査テスト（tests/audit/e2e）
 *   AUDIT_KNOWN=1 npx playwright test -c playwright.audit.config.ts --trace off  … 未解決の不具合の再現（tests/audit/e2e-known。失敗するのが現状）
 * 既存の E2E（ポート 4173）と衝突しないよう 4174 を使う。型検査は別途 `npm run typecheck` で行うので、ここでは vite build のみ。
 */
export default defineConfig({
  testDir: process.env.AUDIT_KNOWN === '1' ? 'tests/audit/e2e-known' : 'tests/audit/e2e',
  timeout: 120_000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4174', viewport: { width: 1600, height: 900 } },
  webServer: {
    command: 'npx vite build && npx vite preview --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
