import { expect, test, type Page } from '@playwright/test';
import { settingsAction } from './settings';
import { tool } from './ui';

// 初期カメラ（src/editor/store.ts）: 左上 (10, 20)、9px/タイル。矢印キー1回でカメラが4タイル動く
const ZOOM = 9;

async function clickTile(page: Page, cam: { x: number; y: number }, tx: number, ty: number) {
  const box = (await page.getByTestId('map').boundingBox())!;
  await page.mouse.click(box.x + (tx + 0.5 - cam.x) * ZOOM, box.y + (ty + 0.5 - cam.y) * ZOOM);
}

async function dragTiles(page: Page, cam: { x: number; y: number }, from: [number, number], to: [number, number]) {
  const box = (await page.getByTestId('map').boundingBox())!;
  const p = (t: [number, number]) => ({ x: box.x + (t[0] + 0.5 - cam.x) * ZOOM, y: box.y + (t[1] + 0.5 - cam.y) * ZOOM });
  await page.mouse.move(p(from).x, p(from).y);
  await page.mouse.down();
  await page.mouse.move(p(to).x, p(to).y, { steps: 6 });
  await page.mouse.up();
}

const uncaught = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  page.on('pageerror', (e) => list.push(e.message));
  page.on('dialog', (d) => void d.accept());
  uncaught.set(page, list);
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(uncaught.get(page)).toEqual([]);
});

test('アクセスの画面で手段の状況を確認し、タクシー乗り場を置くとタクシーが使えるようになる', async ({ page }) => {
  await page.getByTestId('tab-access').click();
  const panel = page.getByTestId('access-panel');
  await expect(panel.getByTestId('mode-car')).toContainText('○');
  await expect(panel.getByTestId('mode-taxi')).toContainText('施設がない');
  await expect(panel.getByTestId('mode-rail')).toContainText('施設がない');
  // サンプル空港の一般道路（y=57）沿い、ターミナルの近く
  await (await tool(page, 'facility:taxiStand')).click();
  await clickTile(page, { x: 10, y: 20 }, 40, 58);
  await expect(panel.getByTestId('mode-taxi')).toContainText('○');
  await expect(page.getByTestId('status')).toContainText('エラー 0 · 警告 0');
});

test('土地を購入すると敷地が広がり、拡張計画に購入面積が表示される', async ({ page }) => {
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  const cam = { x: -2, y: 20 };
  await (await tool(page, 'land')).click();
  await dragTiles(page, cam, [2, 60], [5, 64]);
  await page.getByTestId('tab-expansion').click();
  await expect(page.getByTestId('expansion-panel')).toContainText('購入 20');
});

test('キャリアで施設を一時閉鎖すると拡張計画に工事として表示され、元に戻すと取り消される', async ({ page }) => {
  await settingsAction(page, 'new-career');
  await expect(page.getByTestId('company-badge')).toContainText('キャリア');
  await clickTile(page, { x: 10, y: 20 }, 49, 43); // スポット 1
  await expect(page.getByTestId('prop-title')).toHaveText('スポット 1');
  await page.getByTestId('prop-close').click();
  await expect(page.getByTestId('project-info')).toContainText('一時閉鎖');
  await page.getByTestId('tab-expansion').click();
  await expect(page.getByTestId('projects')).toContainText('スポット 1');
  await expect(page.getByTestId('impact')).toContainText('2か所');
  await page.keyboard.press('Escape');
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('projects')).not.toContainText('スポット 1');
});
