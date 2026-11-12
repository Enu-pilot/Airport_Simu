import { expect, test, type Page } from '@playwright/test';

// Phase 12: 自由方位・実寸の滑走路。初期カメラ（src/editor/store.ts）: 左上 (10, 20)、9px/タイル
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

/** 数値入力モードの自由形を、中点基準でクリックした位置に置く */
async function placeNumeric(page: Page, tile: [number, number], headingDeg: number, lengthM: number) {
  await page.getByTestId('opt-freeHeading').fill(String(headingDeg));
  await page.getByTestId('opt-freeHeading').press('Enter');
  await page.getByTestId('opt-freeLength').fill(String(lengthM));
  await page.getByTestId('opt-freeLength').press('Enter');
  await clickTile(page, ...tile);
}

async function selectFreeNumeric(page: Page) {
  await page.getByTestId('tool-runway').click();
  await page.getByTestId('opt-runwayAlignment').selectOption('free');
  await page.getByTestId('opt-freeInput').selectOption('numeric');
  await page.getByTestId('opt-freeAnchor').selectOption('mid');
}

async function deselect(page: Page) {
  await page.getByTestId('tool-select').click();
  await page.keyboard.press('Escape'); // 選択解除
}

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

test('自由形の滑走路を任意の方位で置き、番号が決まり、磁気偏角を変えると番号が変わる', async ({ page }) => {
  await page.getByTestId('new-empty').click();
  await selectFreeNumeric(page);
  await placeNumeric(page, [80, 60], 37, 1800);

  await expect(page.getByTestId('badge-free')).toBeVisible();
  await expect(page.getByTestId('prop-trueHeading')).toHaveValue('37');
  await expect(page.getByTestId('prop-designators')).toHaveText('04/22');
  await expect(page.getByTestId('prop-magHeading')).toContainText('37.0°');

  // プロパティの真方位を 90.5° に変える → 番号が 09/27（90.5 → 磁 90.5 は 9）
  await page.getByTestId('prop-trueHeading').fill('90.5');
  await page.getByTestId('prop-trueHeading').press('Enter');
  await expect(page.getByTestId('prop-designators')).toHaveText('09/27');

  // 接尾辞の上書き
  await page.getByTestId('prop-suffix').selectOption('L');
  await expect(page.getByTestId('prop-designators')).toHaveText('09L/27R');
  await page.getByTestId('prop-suffix').selectOption('auto');
  await expect(page.getByTestId('prop-designators')).toHaveText('09/27');

  // 磁気偏角 10°E → 磁方位 80.5° → 08/26
  await deselect(page);
  await expect(page.getByTestId('airport-settings')).toBeVisible();
  await expect(page.getByTestId('settings-designators')).toContainText('09/27');
  await page.getByTestId('setting-magvar').fill('10');
  await page.getByTestId('setting-magvar').press('Enter');
  await expect(page.getByTestId('settings-designators')).toContainText('08/26');
  await expect(page.getByTestId('setting-magvar-label')).toHaveText('10°E');
  // 注意書き（参考値・ゲーム値）
  await expect(page.getByTestId('runway-disclaimer')).toContainText('実際の安全基準への適合を保証しません');
  await expect(page.getByTestId('setting-ruleExplain')).toContainText('Phase 13');

  // 元に戻すで偏角が戻る
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('settings-designators')).toContainText('09/27');
});

test('ドラッグで自由形を置き、端のハンドルで回転し、R キーでも回せる', async ({ page }) => {
  await page.getByTestId('new-empty').click();
  await page.getByTestId('tool-runway').click();
  await page.getByTestId('opt-runwayAlignment').selectOption('free');
  await page.getByTestId('opt-angleSnap').selectOption('5');
  await dragTiles(page, [30, 70], [90, 40]); // 北東へ。方位は 5° 刻み
  const heading = Number(await page.getByTestId('prop-trueHeading').inputValue());
  expect(heading % 5).toBe(0);
  expect(heading).toBeGreaterThan(40);
  expect(heading).toBeLessThan(80);
  await expect(page.getByTestId('badge-free')).toBeVisible();

  // R キー: 1° ではなく選択した方位の吸着（5°）ずつ
  await page.keyboard.press('Escape'); // 選択ツールへ（選択は維持）
  await page.keyboard.press('r');
  await expect(page.getByTestId('prop-trueHeading')).toHaveValue(String(heading + 5));

  // 終点のハンドルを中点の真南（同じ半径）へ引いて回転 → 方位 180°（始点は真北側）
  const text = (await page.getByText(/^\(-?[\d.]+, -?[\d.]+\) → \(/).first().innerText()).match(/-?[\d.]+/g)!.map(Number);
  const [sx, sy, ex, ey] = text as [number, number, number, number];
  const mid = { x: (sx + ex) / 2, y: (sy + ey) / 2 };
  const radius = Math.hypot(ex - mid.x, ey - mid.y);
  const lengthBefore = await page.getByTestId('prop-lengthM').inputValue();
  const from = await tilePos(page, ex, ey);
  const to = await tilePos(page, mid.x, mid.y + radius);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('prop-trueHeading')).toHaveValue('180');
  expect(await page.getByTestId('prop-lengthM').inputValue()).toBe(lengthBefore); // 長さは保たれる
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('prop-trueHeading')).toHaveValue(String(heading + 5));
});

test('従来形の滑走路を自由形に変換して元に戻す', async ({ page }) => {
  await page.getByTestId('row-rwy_1').click();
  await expect(page.getByTestId('badge-legacy')).toBeVisible();
  await expect(page.getByTestId('prop-heading')).toBeVisible();
  await page.getByTestId('convert-to-free').click();
  await expect(page.getByTestId('convert-confirm')).toContainText('実寸');
  await expect(page.getByTestId('convert-confirm')).toContainText('Undo');
  await page.getByTestId('convert-do').click();
  await expect(page.getByTestId('badge-free')).toBeVisible();
  await expect(page.getByTestId('prop-trueHeading')).toHaveValue('90');
  await expect(page.getByTestId('prop-designators')).toHaveText('09/27');
  // 実寸の寸法と参考値の注意書き
  await expect(page.getByTestId('prop-dim-stripHalfWidthM')).toHaveValue('140');
  await expect(page.getByTestId('runway-reference')).toBeAttached();
  // 元に戻す
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('badge-legacy')).toBeVisible();
  await expect(page.getByTestId('prop-heading')).toBeVisible();
  // 再度変換 → グリッドに合わせて従来形に戻す
  await page.getByTestId('convert-to-free').click();
  await page.getByTestId('convert-do').click();
  await page.getByTestId('snap-to-grid').click();
  await expect(page.getByTestId('snap-confirm')).toContainText('捨てられます');
  await page.getByTestId('snap-do').click();
  await expect(page.getByTestId('badge-legacy')).toBeVisible();
});

test('従来形の向きの選択肢は、磁気偏角を設定すると磁方位の番号になる', async ({ page }) => {
  await page.getByTestId('row-rwy_1').click();
  await expect(page.getByTestId('prop-heading').locator('option:checked')).toHaveText('90°（09/27）');
  await deselect(page);
  await page.getByTestId('setting-magvar').fill('10');
  await page.getByTestId('setting-magvar').press('Enter');
  await page.getByTestId('row-rwy_1').click();
  await expect(page.getByTestId('prop-heading').locator('option:checked')).toHaveText('90°（08/26）');
  await expect(page.getByTestId('prop-magHeading')).toContainText('80°');
});

test('交差する自由形の滑走路 2 本は重なりエラーにならず、交差が認識される', async ({ page }) => {
  await page.getByTestId('new-empty').click();
  await selectFreeNumeric(page);
  await placeNumeric(page, [80, 60], 90, 2000);
  await placeNumeric(page, [80, 60], 30, 2000);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('issues')).not.toContainText('が重なっています');
  await expect(page.getByTestId('issues')).not.toContainText('保護区域');
  // 残るエラーは「誘導路が接続していない」だけ（滑走路 2 本分）
  await expect(page.getByTestId('count-error')).toHaveText('2');
  await expect(page.getByTestId('issues')).toContainText('接続する誘導路がありません');
  // 交差が認識される（交差点は滑走路のプロパティに表示される）
  await page.getByTestId('row-rwy_1').click();
  await expect(page.getByTestId('prop-crossings')).toBeVisible();
});

test('自由形の滑走路を含む空港で運航を開始できる（ページエラーなし）', async ({ page }) => {
  test.setTimeout(60_000);
  await page.getByTestId('row-rwy_1').click();
  await page.getByTestId('convert-to-free').click();
  await page.getByTestId('convert-do').click();
  await expect(page.getByTestId('badge-free')).toBeVisible();
  await page.getByTestId('start-ops').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  await page.getByTestId('speed-240').click();
  await expect(page.getByTestId('sim-clock')).not.toContainText('06:00', { timeout: 20_000 });
  await expect(page.getByTestId('runway-rwy_1')).toContainText('09');
});

test('交差する自由形の滑走路を 2D と 3D で描ける（エラーなし）', async ({ page }) => {
  await page.getByTestId('new-empty').click();
  await selectFreeNumeric(page);
  await placeNumeric(page, [80, 60], 90, 2000);
  await placeNumeric(page, [80, 60], 30, 2000);
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await page.getByTestId('view-toggle').click();
  await expect(page.getByTestId('view3d-canvas')).toBeVisible();
  await page.waitForTimeout(1000);
  await page.getByTestId('view-toggle').click();
  await expect(page.getByTestId('map-canvas')).toBeVisible();
});
