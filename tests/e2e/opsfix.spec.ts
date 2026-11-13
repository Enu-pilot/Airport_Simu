import { expect, test, type Page } from '@playwright/test';

/** 12B-1 監査の修正: 運航モードの読み取り専用詳細・運航表の移動とコンパクト・表示メニュー */

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  page.on('pageerror', (e) => list.push(e.message));
  page.on('dialog', (d) => void d.accept());
  errors.set(page, list);
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await page.getByTestId('start-ops').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

test('運航表は見出しのドラッグで移動でき、コンパクト表示と位置が記憶される', async ({ page }) => {
  const board = page.getByTestId('flight-board');
  const before = (await board.boundingBox())!;
  const head = page.getByTestId('fids-head');
  const hb = (await head.boundingBox())!;
  await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 15000 });
  await page.mouse.move(hb.x + 20, hb.y + 8);
  await page.mouse.down();
  await page.mouse.move(hb.x - 160, hb.y + 90, { steps: 5 });
  await page.mouse.up();
  const after = (await board.boundingBox())!;
  expect(after.x).toBeLessThan(before.x - 100);
  expect(after.y).toBeGreaterThan(before.y + 50);
  await page.getByTestId('fids-compact').click();
  await expect(page.getByTestId('fids-compact')).toHaveAttribute('aria-pressed', 'true');
  const saved = await page.evaluate(() => localStorage.getItem('skyport.fids.v1'));
  expect(JSON.parse(saved!).compact).toBe(true);
  expect(await page.locator('table.fids-table tbody tr').count()).toBeLessThanOrEqual(8);
});

test('運航中の施設の詳細は読み取り専用（回転・複製・削除・編集欄を出さない）', async ({ page }) => {
  await page.getByTestId('tab-disruptions').click();
  await page.getByTestId('disruption-kind').selectOption('runwayClosed');
  await page.getByTestId('disruption-add').click();
  await page.getByTestId('overlay-close').click();
  const alert = page.getByTestId('alert-stack').locator('[data-testid^="alert-disruption:runwayClosed"]').first();
  await alert.getByRole('button', { name: /一時閉鎖/ }).click();
  await expect(page.getByTestId('prop-title')).toBeVisible();
  await expect(page.getByTestId('prop-delete')).toHaveCount(0);
  await expect(page.getByTestId('prop-readonly-fields')).toBeVisible();
  await expect(page.getByTestId('prop-readonly-fields').locator('input:not(:disabled), select:not(:disabled)')).toHaveCount(0);
});

test('上部の表示切り替えは運航モードでは「表示」メニューにまとまる', async ({ page }) => {
  await expect(page.getByTestId('overlays-pop')).toBeVisible();
  await page.getByTestId('overlays-pop').locator('summary').click();
  await expect(page.getByTestId('overlay-network')).toBeVisible();
});
