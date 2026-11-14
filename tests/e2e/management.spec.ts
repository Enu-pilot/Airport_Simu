import { expect, test, type Page } from '@playwright/test';
import { settingsAction } from './settings';

// 初期カメラ（src/editor/store.ts）: 左上 (10, 20)、9px/タイル
const CAM = { x: 10, y: 20, zoom: 9 };

async function clickTile(page: Page, tx: number, ty: number) {
  const box = (await page.getByTestId('map').boundingBox())!;
  await page.mouse.click(box.x + (tx + 0.5 - CAM.x) * CAM.zoom, box.y + (ty + 0.5 - CAM.y) * CAM.zoom);
}

const uncaught = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  page.on('pageerror', (e) => list.push(e.message));
  page.on('dialog', (d) => void d.accept());
  uncaught.set(page, list);
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await settingsAction(page, 'new-career');
  await expect(page.getByTestId('company-badge')).toContainText('キャリア');
});

test.afterEach(async ({ page }) => {
  expect(uncaught.get(page)).toEqual([]);
});

test('新しいゲームは小さな飛行場と初期資金・初期契約で始まり、翌日の運航計画が表示される', async ({ page }) => {
  await expect(page.getByTestId('cash')).toContainText('4,000,000 cr');
  await expect(page.getByTestId('count-error')).toHaveText('0');
  await page.getByTestId('tab-plan').click();
  const panel = page.getByTestId('plan-panel');
  await expect(panel.getByTestId('contracts')).toContainText('リージョナルジェット');
  await expect(panel.getByTestId('contracts')).toContainText('ハミングバード');
  await expect(panel.getByTestId('plan-schedule').locator('tbody tr')).toHaveCount(3);
  await expect(panel).toContainText('実在の空港料金とは無関係');
});

test('建設すると建設費を支払い、元に戻すと同額が戻る。資金が足りない建設はできない', async ({ page }) => {
  await page.getByTestId('tool-facility:tower').click();
  await clickTile(page, 86, 52);
  // 管制塔 800,000 × 規模係数 1.0968（docs/15 §5）
  await expect(page.getByTestId('cash')).toContainText('3,122,555 cr');
  await page.keyboard.press('Escape');
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('cash')).toContainText('4,000,000 cr');
  // サンプル空港の建設費は初期資金を大きく超える
  await settingsAction(page, 'load-sample');
  await expect(page.getByTestId('toast')).toContainText('資金不足');
  await expect(page.getByTestId('cash')).toContainText('4,000,000 cr');
});

test('運航すると収入・費用が計上され、運航を終えるとその日を締めて日報が残る', async ({ page }) => {
  await page.getByTestId('page-operations').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  await page.getByTestId('speed-600').click();
  await page.getByTestId('tab-finance').click();
  const ledger = page.getByTestId('today-ledger');
  await expect(ledger).toContainText('人件費');
  await expect(ledger).toContainText('着陸料', { timeout: 25_000 });
  await page.getByTestId('stop-ops').click();
  await expect(page.getByTestId('toast')).toContainText('1日目を締めました');
  await page.getByTestId('tab-finance').click();
  await expect(page.getByTestId('reports')).toContainText('1日目（途中）');
  await expect(page.getByTestId('company-day')).toHaveText('2日目');
  await expect(page.getByTestId('kpi-otp')).toBeVisible();
});
