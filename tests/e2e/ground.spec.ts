import { expect, test, type Page } from '@playwright/test';

const uncaught = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  page.on('pageerror', (e) => list.push(e.message));
  uncaught.set(page, list);
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await page.getByTestId('start-ops').click();
});

test.afterEach(async ({ page }) => {
  expect(uncaught.get(page)).toEqual([]);
});

test('地上支援の画面で作業員・車両の配置と設備を確認し、車両を故障させられる', async ({ page }) => {
  await page.getByTestId('tab-ground').click();
  const board = page.getByTestId('ground-board');
  await expect(board.getByTestId('units-staff')).toContainText('作業員');
  await expect(board.getByTestId('units-fuelTruck')).toContainText('給油車');
  await expect(board).toContainText('手荷物仕分け場');
  const firstTug = board.locator('tr', { hasText: 'トーイングカー gu_' }).first();
  await firstTug.getByRole('button', { name: '故障' }).click();
  await expect(firstTug).toContainText('故障');
  await expect(board.getByTestId('units-tug')).toContainText('1');
});

test('到着した機体の折り返し作業の進捗と手荷物の状況が表示される', async ({ page }) => {
  await page.getByTestId('add-arrival').click();
  await page.locator('table.board tbody tr', { hasText: '到着処理中' }).first().click();
  await page.getByTestId('speed-240').click();
  const turnaround = page.getByTestId('turnaround');
  await expect(turnaround).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('task-fuel')).toBeVisible();
  await expect(page.getByTestId('task-board')).toContainText('搭乗');
  await page.getByTestId('tab-baggage').click();
  await expect(page.getByTestId('baggage-board')).toContainText('到着');
});
