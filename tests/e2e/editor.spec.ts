import { expect, test, type Page } from '@playwright/test';

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

const errors = (page: Page) => page.getByTestId('count-error');
const warnings = (page: Page) => page.getByTestId('count-warning');

const uncaught = new WeakMap<Page, string[]>();

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

test('起動するとサンプル空港がエラー・警告なしで表示される', async ({ page }) => {
  await expect(errors(page)).toHaveText('0');
  await expect(warnings(page)).toHaveText('0');
  await expect(page.getByTestId('row-rwy_1')).toBeVisible();
});

test('施設を配置して元に戻す・やり直す', async ({ page }) => {
  await page.getByTestId('tool-facility:tower').click();
  await clickTile(page, 115, 70);
  await expect(page.getByTestId('status')).toContainText('施設 21');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('status')).toContainText('施設 20');
  await page.getByTestId('redo').click();
  await expect(page.getByTestId('status')).toContainText('施設 21');
});

test('選択してプロパティを表示し、削除を取り消す', async ({ page }) => {
  await clickTile(page, 49, 43); // スポット 1
  await expect(page.getByTestId('prop-title')).toHaveText('スポット 1');
  await expect(page.getByTestId('operability')).toContainText('運用可能');
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('properties')).toContainText('施設を選択すると');
  await expect(warnings(page)).not.toHaveText('0'); // ゲートのスポットが無くなる
  await page.keyboard.press('Control+z');
  await expect(warnings(page)).toHaveText('0');
});

test('建物を滑走路の保護区域へ移動するとエラーになり、取り消すと解消する', async ({ page }) => {
  await dragTiles(page, [120, 44], [120, 31]); // 管制塔
  await expect(errors(page)).not.toHaveText('0');
  await expect(page.getByTestId('issues')).toContainText('保護区域');
  await page.getByTestId('undo').click();
  await expect(errors(page)).toHaveText('0');
});

test('孤立した誘導路は警告として表示される', async ({ page }) => {
  await page.getByTestId('tool-taxiway').click();
  await clickTile(page, 60, 75);
  await clickTile(page, 80, 75);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('issues')).toContainText('滑走路につながっていない誘導路');
});

test('滑走路をドラッグで配置し、プロパティで長さを変更する', async ({ page }) => {
  await page.getByTestId('tool-runway').click();
  await dragTiles(page, [20, 85], [100, 85]);
  await expect(page.getByTestId('prop-maxSize')).toHaveText('M級まで');
  await page.getByTestId('prop-length').fill('30');
  await page.getByTestId('prop-length').press('Enter');
  await expect(page.getByTestId('prop-maxSize')).toHaveText('使用不可');
  await expect(page.getByTestId('issues')).toContainText('短すぎ');
});

test('空の敷地 → サンプル空港を生成', async ({ page }) => {
  await page.getByTestId('new-empty').click();
  await expect(page.getByTestId('issues')).toContainText('滑走路がありません');
  await page.getByTestId('load-sample').click();
  await expect(errors(page)).toHaveText('0');
  await expect(warnings(page)).toHaveText('0');
});
