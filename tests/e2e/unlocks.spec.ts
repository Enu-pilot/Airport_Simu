import { expect, test, type Page } from '@playwright/test';
import { settingsAction } from './settings';

/** フェーズ 4（4-01 の画面）: 格で解放されるまで、新しいエリアは選べず理由が出る */
const uncaught = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  page.on('pageerror', (e) => list.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') list.push(`console: ${m.text()}`); });
  page.on('dialog', (d) => void d.accept());
  uncaught.set(page, list);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId('map-canvas')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(uncaught.get(page)).toEqual([]);
});

test('キャリア開始直後（格 0）: 国際・乗継のエリアはロックされ、設定の機能も選べない', async ({ page }) => {
  await settingsAction(page, 'new-game-setup');
  await page.getByTestId('setup-mode-career').check();
  await page.getByTestId('setup-start').click();

  // ツールボックス: 出国審査はロック（理由つき）、保安検査は通常どおり選べる
  const emigration = page.getByTestId('tool-area:emigration');
  await expect(emigration).toBeDisabled();
  await expect(emigration).toContainText('格 3（国際ハブ）で解放');
  await expect(page.getByTestId('tool-area:transferSecurity')).toBeDisabled();
  await expect(page.getByTestId('tool-area:security')).toBeEnabled();

  // 設定画面: 機能のチェックボックスもロックされる
  await settingsAction(page, 'tab-settings');
  await expect(page.getByTestId('setup-feature-overnight')).toBeDisabled();
  await expect(page.getByTestId('setup-feature-international')).toBeDisabled();
});
