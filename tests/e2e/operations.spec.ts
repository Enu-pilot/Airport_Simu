import { expect, test, type Page } from '@playwright/test';

const uncaught = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  page.on('pageerror', (e) => list.push(e.message));
  uncaught.set(page, list);
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await page.getByTestId('start-ops').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(uncaught.get(page)).toEqual([]);
});

test('運航を開始すると便が生成され、時間が進み、到着・出発が完了する', async ({ page }) => {
  await expect(page.getByTestId('sim-clock')).toContainText('1日目 06:');
  await page.getByTestId('speed-600').click();
  // 最初の便（06:30以降に到着、折り返して出発）が完了するまで
  await expect(page.getByTestId('stat-departures')).not.toHaveText('0', { timeout: 25_000 });
  await expect(page.getByTestId('stat-arrivals')).not.toHaveText('0');
  await expect(page.getByTestId('stat-conflicts')).toHaveText('0');
});

test('一時停止中は時刻が進まず、再開すると進む', async ({ page }) => {
  await page.keyboard.press('Space');
  const t1 = await page.getByTestId('sim-clock').innerText();
  await page.waitForTimeout(1000);
  expect(await page.getByTestId('sim-clock').innerText()).toBe(t1);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('sim-clock')).not.toHaveText(t1);
});

test('追加した到着便を運航表から選ぶと、機体の状態と運航履歴が表示される', async ({ page }) => {
  await page.getByTestId('add-arrival').click();
  const row = page.locator('table.board tbody tr', { hasText: '到着処理中' }).first();
  await row.click();
  await expect(page.getByTestId('aircraft-panel')).toBeVisible();
  await expect(page.getByTestId('aircraft-history')).toContainText('到着処理中');
  await page.getByTestId('speed-240').click();
  await expect(page.getByTestId('aircraft-history')).toContainText('駐機中', { timeout: 20_000 });
});

test('運航中はレイアウトを編集できず、建設モードに戻ると編集できる', async ({ page }) => {
  await expect(page.getByTestId('toolbox')).toHaveCount(0);
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('stop-ops').click();
  await expect(page.getByTestId('toolbox')).toBeVisible();
  await expect(page.getByTestId('undo')).toBeVisible();
});
