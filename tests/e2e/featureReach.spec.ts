import { expect, test, type Page } from '@playwright/test';
import { settingsAction } from './settings';

/**
 * 2026-11-22 総合テスト: 近時に追加したバックエンド機能が、ゲーム内 UI から発見・設定・確定・状態確認まで
 * 操作できるか（docs/45 §5.3〜5.6 のプレイ可能性）。既存 E2E に網羅のなかった機能だけを対象にする。
 * 対象: Work Order、表示モード（地図なし・無描画）、防音工事・騒音対策費、PBB、ターミナル設計 Workspace、
 * ラウンジ・住民向け施設のツール、建設／運航のショートカットキー。
 */

// 初期カメラ（src/editor/store.ts）: 左上 (10, 20)、9px/タイル
const CAM = { x: 10, y: 20, zoom: 9 };

async function clickTile(page: Page, tx: number, ty: number) {
  const box = (await page.getByTestId('map').boundingBox())!;
  await page.mouse.click(box.x + (tx + 0.5 - CAM.x) * CAM.zoom, box.y + (ty + 0.5 - CAM.y) * CAM.zoom);
}

async function dragTiles(page: Page, from: [number, number], to: [number, number]) {
  const box = (await page.getByTestId('map').boundingBox())!;
  const p = (t: [number, number]) => ({ x: box.x + (t[0] + 0.5 - CAM.x) * CAM.zoom, y: box.y + (t[1] + 0.5 - CAM.y) * CAM.zoom });
  await page.mouse.move(p(from).x, p(from).y);
  await page.mouse.down();
  await page.mouse.move(p(to).x, p(to).y, { steps: 8 });
  await page.mouse.up();
}

const uncaught = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  page.on('pageerror', (e) => list.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') list.push(`console: ${m.text()}`); });
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

const status = (page: Page) => page.getByTestId('status');

test('Work Order: 経営画面から作成でき、一覧に載り、運航中は読み取り専用になる', async ({ page }) => {
  await page.getByTestId('page-management').click();
  await page.getByTestId('management-plan').click();
  await expect(page.getByTestId('wo-asset-kind')).toBeVisible();
  await page.getByTestId('wo-engineers').fill('2');
  await page.getByTestId('wo-duration').fill('60');
  await page.getByTestId('wo-create').click();
  await expect(page.getByTestId('wo-list')).toBeVisible();
  await expect(page.getByTestId('wo-list').locator('tbody tr')).toHaveCount(1);
  await page.getByTestId('board-close').click();
  await page.getByTestId('page-operations').click();
  await page.getByTestId('page-management').click();
  await page.getByTestId('management-plan').click();
  await expect(page.getByTestId('wo-readonly')).toBeVisible();
  await expect(page.getByTestId('wo-list').locator('tbody tr')).toHaveCount(1);
});

test('表示モード: 地図なし・無描画に切り替えても時刻が進み、地図表示へ戻せる', async ({ page }) => {
  await page.getByTestId('page-operations').click();
  await page.getByTestId('speed-600').click();
  await page.getByTestId('display-nomap').click();
  await expect(page.getByTestId('display-nomap')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('display-norender').click();
  await expect(page.getByTestId('headless-status')).toBeVisible();
  await expect(page.getByTestId('headless-speed')).toHaveText('×600');
  const c0 = await page.getByTestId('headless-clock').textContent();
  await expect(page.getByTestId('headless-clock')).not.toHaveText(c0!, { timeout: 5_000 });
  await page.getByTestId('headless-exit').click();
  await expect(page.getByTestId('headless-status')).toHaveCount(0);
  await expect(page.getByTestId('sim-clock')).toBeVisible();
});

test('防音工事・騒音対策費: キャリアで実施でき、Lv と拠出済み表示が更新される', async ({ page }) => {
  await settingsAction(page, 'new-game-setup');
  await page.getByTestId('setup-mode-career').check();
  await expect(page.getByTestId('setup-city-enabled')).toBeChecked();
  await page.getByTestId('setup-start').click();
  await page.getByTestId('page-management').click();
  await page.getByTestId('management-plan').click();
  const panel = page.getByTestId('soundproof-panel');
  await expect(panel).toContainText('防音工事 Lv0');
  await page.getByTestId('soundproof-buy').click();
  await expect(panel).toContainText('防音工事 Lv1');
  await page.getByTestId('noise-contribution').click();
  await expect(page.getByTestId('noise-contribution')).toBeDisabled();
  await expect(panel).toContainText('今日は拠出済み');
});

test('PBB: ゲートを選ぶと搭乗橋の節が出て、追加すると基数が増える', async ({ page }) => {
  await clickTile(page, 49, 48); // サンプル空港のゲート 1
  const section = page.getByTestId('gate-pbb-section');
  await expect(section).toBeVisible();
  const before = await page.locator('[data-testid^="pbb-unit-"]').count();
  const add = page.getByTestId('pbb-add');
  // 追加ボタン → 続けてスポットをクリック（ゲート 1 に紐付くスポット 1 は (48, 44) から）
  await add.click();
  await expect(page.getByTestId('tool-pbb')).toHaveClass(/active/);
  await clickTile(page, 49, 45);
  await page.keyboard.press('Escape');
  await clickTile(page, 49, 48);
  await expect(page.getByTestId('gate-pbb-section')).toBeVisible();
  await expect(page.locator('[data-testid^="pbb-unit-"]')).toHaveCount(Math.max(1, before));
  await expect(page.getByTestId('pbb-synthesized')).toHaveCount(0);
});

test('ターミナル設計 Workspace: ターミナルの属性から開き、階と能力を確認して閉じられる', async ({ page }) => {
  await clickTile(page, 70, 55); // サンプル空港の旅客ターミナル（地上階）
  await page.getByTestId('open-terminal-workspace').click();
  await expect(page.getByTestId('terminal-workspace')).toBeVisible();
  await expect(page.getByTestId('workspace-capacity')).toBeVisible();
  await expect(page.getByTestId('workspace-floor-summary')).toBeVisible();
  await expect(page.getByTestId('workspace-gates')).toBeVisible();
  await page.getByTestId('workspace-close').click();
  await expect(page.getByTestId('terminal-workspace')).toHaveCount(0);
});

test('ラウンジと住民向け施設: ツールが見つかり、公園をドラッグで配置できる', async ({ page }) => {
  await expect(page.getByTestId('tool-area:lounge')).toHaveCount(1);
  // ツールはカテゴリ見出しを開いてから押す（折りたたみ表示）
  const park = page.getByTestId('tool-facility:park');
  if (!(await park.isVisible())) await page.getByText('住民向け施設', { exact: true }).click();
  await park.click();
  const before = await status(page).textContent();
  await dragTiles(page, [14, 72], [21, 78]); // 表示範囲内・駐車場の左の空き地
  await expect(status(page)).not.toHaveText(before!);
});

test('ショートカット: 建設は T/P でツール、S/M/L/F でサイズ、数字で階、G でレイヤ。運航は数字で倍率・Space で一時停止', async ({ page }) => {
  await page.getByTestId('map').hover();
  await page.keyboard.press('t');
  await expect(page.getByTestId('tool-taxiway')).toHaveClass(/active/);
  await page.keyboard.press('f');
  await expect(page.getByTestId('toast')).toContainText('F');
  await page.keyboard.press('p');
  await expect(page.getByTestId('tool-stand')).toHaveClass(/active/);
  await page.keyboard.press('l');
  await expect(page.getByTestId('toast')).toContainText('スポットのサイズ');
  await page.keyboard.press('2');
  await expect(page.getByTestId('toast')).toContainText('表示階: 2F');
  await page.keyboard.press('g');
  await expect(page.getByTestId('toast')).toContainText('グリッド');
  await page.keyboard.press('Escape');
  await page.getByTestId('page-operations').click();
  await page.getByTestId('map').hover();
  await page.keyboard.press('5');
  await expect(page.getByTestId('speed-600')).toHaveClass(/active/);
  await page.keyboard.press('Space');
  const c0 = await page.getByTestId('sim-clock').textContent();
  await page.waitForTimeout(600);
  await expect(page.getByTestId('sim-clock')).toHaveText(c0!);
});
