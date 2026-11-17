import { expect, test, type Page } from '@playwright/test';
import { settingsAction } from './settings';

/** フェーズ 2（2-11・2-15 の画面）: 夜間の運用（最終出発時刻）の設定。新規ゲームで都市を選ぶと既定で有効、既存データには入れない */
const uncaught = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  page.on('pageerror', (e) => list.push(e.message));
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

async function openPlan(page: Page) {
  await page.getByTestId('tab-plan').click();
  await expect(page.getByTestId('plan-panel')).toBeVisible();
}

test('従来の初回起動（都市なし）では夜間の運用の欄は出ない', async ({ page }) => {
  await openPlan(page);
  await expect(page.getByTestId('night-ops')).toHaveCount(0);
});

test('新規ゲームで都市を選ぶと最終出発時刻 21:15 が既定で入り、変更・解除できる。範囲外は選べない', async ({ page }) => {
  await settingsAction(page, 'new-game-setup');
  await page.getByTestId('setup-mode-career').check();
  await expect(page.getByTestId('setup-city-enabled')).toBeChecked();
  await page.getByTestId('setup-start').click();
  await openPlan(page);
  await expect(page.getByTestId('night-ops')).toBeVisible();
  await expect(page.getByTestId('nightops-enabled')).toBeChecked();
  await expect(page.getByTestId('nightops-cutoff')).toHaveValue('1275');
  await expect(page.getByTestId('nightops-cutoff').locator('option:checked')).toHaveText('21:15');
  await expect(page.getByTestId('nightops-cutoff').locator('option')).toHaveCount(22); // 20:00〜21:45 を 5 分刻み
  await page.getByTestId('nightops-cutoff').selectOption('1200');
  await expect(page.getByTestId('nightops-cutoff')).toHaveValue('1200');
  // 数値は範囲に丸める
  await page.getByTestId('nightops-airborne-max').fill('500');
  await expect(page.getByTestId('nightops-airborne-max')).toHaveValue('120');
  await page.getByTestId('nightops-warn-lead').fill('0');
  await expect(page.getByTestId('nightops-warn-lead')).toHaveValue('0');
  await page.getByTestId('nightops-prioritize').check();
  await expect(page.getByTestId('nightops-prioritize')).toBeChecked();
  // 解除すると欄が畳まれ、再度有効にすると既定値（21:15）に戻る
  await page.getByTestId('nightops-enabled').uncheck();
  await expect(page.getByTestId('nightops-cutoff')).toHaveCount(0);
  await page.getByTestId('nightops-enabled').check();
  await expect(page.getByTestId('nightops-cutoff')).toHaveValue('1275');
});

test('運航中は設定を変更できない（読み取り専用の案内が出て、入力が無効）', async ({ page }) => {
  await settingsAction(page, 'new-game-setup');
  await page.getByTestId('setup-mode-career').check();
  await page.getByTestId('setup-start').click();
  await page.getByTestId('page-operations').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  await page.getByTestId('page-management').click(); // 既定の節は「需要・運航計画」
  await expect(page.getByTestId('plan-panel')).toBeVisible();
  await expect(page.getByTestId('nightops-enabled')).toBeDisabled();
  await expect(page.getByTestId('nightops-readonly')).toBeVisible();
});
