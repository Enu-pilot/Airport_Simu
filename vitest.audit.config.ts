/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

/**
 * 監査用テスト（docs/39_comprehensive_test_audit_and_handover.md）。通常の `npm test` には含めない。
 *   npx vitest run -c vitest.audit.config.ts                      … 合格する監査テスト（tests/audit/*.audit.test.ts）
 *   AUDIT_KNOWN=1 npx vitest run -c vitest.audit.config.ts        … 未解決の不具合の再現テスト（tests/audit/known-issues。失敗するのが現状）
 */
const known = process.env.AUDIT_KNOWN === '1';
export default defineConfig({
  test: {
    include: known ? ['tests/audit/known-issues/**/*.repro.test.ts'] : ['tests/audit/*.audit.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
