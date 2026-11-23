import { expect, test, type Page } from '@playwright/test';
import { tool } from './ui';

const CAM = { x: 10, y: 20, zoom: 9 };
const uncaught = new WeakMap<Page, string[]>();

async function tilePos(page: Page, tx: number, ty: number) {
  const box = (await page.getByTestId('map').boundingBox())!;
  return { x: box.x + (tx + 0.5 - CAM.x) * CAM.zoom, y: box.y + (ty + 0.5 - CAM.y) * CAM.zoom };
}

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  page.on('pageerror', (e) => list.push(e.message));
  uncaught.set(page, list);
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(uncaught.get(page)).toEqual([]);
});

test('ターミナル内部のエリアを階を選んで配置し、選択してプロパティを編集できる', async ({ page }) => {
  await page.getByTestId('level-0').click();
  await (await tool(page, 'area:restroom')).click();
  // 1F の空いている場所（西端、到着通路の下）にドラッグで配置
  const a = await tilePos(page, 47, 52);
  const b = await tilePos(page, 49, 53);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('prop-title')).toContainText('1F トイレ');
  await page.getByTestId('prop-fixtures').fill('10');
  await page.getByTestId('prop-fixtures').press('Enter');
  await expect(page.getByTestId('prop-fixtures')).toHaveValue('10');
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('prop-fixtures')).toHaveValue('6');
});

test('エスカレーターを選択してもブラックアウトせず、能力を編集できる（React #301 回帰）', async ({ page }) => {
  await page.getByTestId('level-0').click();
  // サンプル空港のエスカレーター（86,52 / 4×2）の中央をクリックして選択
  const p = await tilePos(page, 88, 53);
  await page.mouse.click(p.x, p.y);
  await expect(page.getByTestId('prop-title')).toContainText('エスカレーター');
  // capacityPerHour は未設定（運航では既定能力を使う）ので空欄。落ちずに表示されること
  await expect(page.getByTestId('prop-capacityPerHour')).toHaveValue('');
  await page.getByTestId('prop-capacityPerHour').fill('3000');
  await page.getByTestId('prop-capacityPerHour').press('Enter');
  await expect(page.getByTestId('prop-capacityPerHour')).toHaveValue('3000');
});

test('運航中のターミナル表で旅客数・待ち時間を確認し、施設を閉鎖できる', async ({ page }) => {
  await page.getByTestId('page-operations').click();
  await page.getByTestId('speed-600').click();
  await page.getByTestId('tab-terminal').click();
  const board = page.getByTestId('terminal-board');
  await expect(board).toContainText('保安検査場');
  await expect(board).not.toContainText('館内 0人', { timeout: 20_000 });
  const securityRow = board.locator('tr', { hasText: '保安検査場' });
  await securityRow.getByRole('button', { name: '閉鎖' }).click();
  await expect(securityRow.getByRole('button', { name: '再開' })).toBeVisible();
  await expect(page.getByTestId('tab-events')).toBeVisible();
});
