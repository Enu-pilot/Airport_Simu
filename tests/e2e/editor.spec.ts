import { expect, test, type Page } from '@playwright/test';
import { settingsAction } from './settings';
import { inboxEl, row, tool } from './ui';

// 初期カメラ（src/editor/store.ts）: 左上 (10, 20)、9px/タイル
const CAM = { x: 10, y: 20, zoom: 9 };

async function tilePos(page: Page, tx: number, ty: number) {
  const box = (await page.getByTestId('map').boundingBox())!;
  return { x: box.x + (tx + 0.5 - CAM.x) * CAM.zoom, y: box.y + (ty + 0.5 - CAM.y) * CAM.zoom };
}

async function clickTile(page: Page, tx: number, ty: number) {
  const p = await tilePos(page, tx, ty);
  await page.mouse.click(p.x, p.y);
}

async function dragTiles(page: Page, from: [number, number], to: [number, number]) {
  const a = await tilePos(page, ...from);
  const b = await tilePos(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
}

const errors = (page: Page) => inboxEl(page, 'count-error');
const warnings = (page: Page) => inboxEl(page, 'count-warning');

const uncaught = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  page.on('dialog', (d) => void d.accept());
  page.on('pageerror', (e) => list.push(e.message));
  uncaught.set(page, list);
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(uncaught.get(page)).toEqual([]);
});

test('起動するとサンプル空港がエラー・警告なしで表示される', async ({ page }) => {
  await expect(await errors(page)).toHaveText('0');
  await expect(await warnings(page)).toHaveText('0');
  await expect((await row(page, 'rwy_1'))).toBeVisible();
});

test('施設を配置して元に戻す・やり直す', async ({ page }) => {
  await (await tool(page, 'facility:tower')).click();
  await clickTile(page, 115, 70);
  await expect(page.getByTestId('status')).toContainText('施設 21');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('status')).toContainText('施設 20');
  await page.getByTestId('redo').click();
  await expect(page.getByTestId('status')).toContainText('施設 21');
});

test('選択してプロパティを表示し、削除を取り消す', async ({ page }) => {
  await clickTile(page, 49, 45); // スポット 1（PR #63 のスポット寸法見直し後の中心付近）
  await expect(page.getByTestId('prop-title')).toHaveText('スポット 1');
  await expect(page.getByTestId('operability')).toContainText('運用可能');
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('properties')).toContainText('施設を選択すると');
  await expect(await warnings(page)).not.toHaveText('0'); // ゲートのスポットが無くなる
  await page.keyboard.press('Control+z');
  await expect(await warnings(page)).toHaveText('0');
});

test('建物を滑走路の保護区域へ移動するとエラーになり、取り消すと解消する', async ({ page }) => {
  await dragTiles(page, [32, 40], [32, 31]); // 格納庫（管制塔 x=120 は既定の表示範囲外になったため、表示範囲内の建物で検証する）
  await expect(await errors(page)).not.toHaveText('0');
  await expect((await inboxEl(page, 'issues'))).toContainText('保護区域');
  await page.getByTestId('undo').click();
  await expect(await errors(page)).toHaveText('0');
});

test('孤立した誘導路は警告として表示される', async ({ page }) => {
  await (await tool(page, 'taxiway')).click();
  await clickTile(page, 60, 75);
  await clickTile(page, 80, 75);
  await page.keyboard.press('Enter');
  await expect((await inboxEl(page, 'issues'))).toContainText('滑走路につながっていない誘導路');
});

test('滑走路をドラッグで配置し、プロパティで長さを変更する', async ({ page }) => {
  await (await tool(page, 'runway')).click();
  await dragTiles(page, [20, 78], [100, 78]); // y=85 は既定の地図表示範囲の外になったため、範囲内の空き地へ
  await expect(page.getByTestId('prop-maxSize')).toHaveText('M級まで');
  await page.getByTestId('prop-length').fill('30');
  await page.getByTestId('prop-length').press('Enter');
  await expect(page.getByTestId('prop-maxSize')).toHaveText('使用不可');
  await expect((await inboxEl(page, 'issues'))).toContainText('短すぎ');
});

test('空の敷地 → サンプル空港を生成', async ({ page }) => {
  await settingsAction(page, 'new-empty');
  await expect((await inboxEl(page, 'issues'))).toContainText('滑走路がありません');
  await settingsAction(page, 'load-sample');
  await expect(await errors(page)).toHaveText('0');
  await expect(await warnings(page)).toHaveText('0');
});
