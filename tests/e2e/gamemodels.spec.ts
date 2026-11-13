import { expect, test, type Page } from '@playwright/test';
import { createSandboxCompany } from '../../src/core/economy/company';
import { defaultGame } from '../../src/core/economy/game';
import { buildProject, serializeProject } from '../../src/core/io/project';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSimulation } from '../../src/core/sim/simulation';
import { stepTicks } from '../../src/core/sim/dayloop';
import { DAY_SEC } from '../../src/core/sim/rules';

/**
 * ゲームのモデル（12B-3a Part B）: 新しいゲームの設定（難易度）・天候 5 段階と予報・先行欠航・従来のサンドボックスは変わらない。
 * 悪天の日は、会社の暦の日を固定したプロジェクト（seed 'sandbox' / humid / expert の 11 日目は 6 時から段階 4）を読み込んで再現する。
 */
const uncaught = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  page.on('pageerror', (e) => list.push(e.message));
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

/** ゲーム設定つきのサンプル空港のプロジェクト。day = 会社の暦の日（0 始まり）、nearMidnight = 0:00 の少し前まで運航した状態 */
function gameProject(opts: { day: number; difficulty?: 'normal' | 'hard' | 'expert'; climate?: 'temperate' | 'snowy' | 'humid'; nearMidnight?: boolean }): string {
  const layout = createSampleAirport();
  const company = createSandboxCompany();
  company.day = opts.day;
  company.game = { ...defaultGame(opts.difficulty ?? 'normal', opts.climate ?? 'temperate'), airlineEval: false, goals: false };
  let sim = null;
  if (opts.nearMidnight) {
    sim = createSimulation(layout, { seed: 'e2e-game', company });
    stepTicks(sim, DAY_SEC - 20 - sim.state.now);
  }
  return serializeProject(buildProject({ name: 'game', savedAt: '2026-01-01T00:00:00.000Z', layout, company: sim?.company ?? company, pin: null, scenarios: [], sim }));
}

async function load(page: Page, json: string) {
  await page.getByTestId('tab-project').click();
  await page.getByTestId('project-file').setInputFiles({ name: 'game.json', mimeType: 'application/json', buffer: Buffer.from(json) });
}

test('新しいゲーム（設定）で難易度を選ぶと、資金・難易度の表示が変わり、運航で天候の段階と明日の予報が出る', async ({ page }) => {
  await page.getByTestId('new-game-setup').click();
  await expect(page.getByTestId('game-setup-dialog')).toBeVisible();
  await page.getByTestId('setup-mode-career').check();
  await page.getByTestId('setup-difficulty-hard').check();
  await page.getByTestId('setup-start').click();
  await expect(page.getByTestId('game-setup-dialog')).toHaveCount(0);
  await expect(page.getByTestId('company-day')).toHaveText('1日目');
  await expect(page.getByTestId('game-difficulty')).toContainText('難しい');
  await expect(page.getByTestId('cash')).toContainText('3,000,000'); // 4,000,000 × 0.75
  await page.getByTestId('start-ops').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  // 最初の日は晴れ（段階 0）。上部バー・天候カードに段階が出て、明日の予報（3 区間）が見える
  await expect(page.getByTestId('weather-level')).toHaveAttribute('data-level', '0');
  await expect(page.getByTestId('weather-level-top')).toBeVisible();
  await expect(page.getByTestId('weather-forecast')).toBeVisible();
  await expect(page.getByTestId('weather-forecast-6')).toBeVisible();
  await expect(page.getByTestId('weather-forecast-12')).toBeVisible();
  await expect(page.getByTestId('weather-forecast-18')).toBeVisible();
});

test('標準の新しいゲーム（new-career）は従来の資金のまま。サンドボックスの初回起動は従来のルールで天候の段階・予報を出さない', async ({ page }) => {
  // 初回起動 = 従来のサンドボックス（game なし）
  await expect(page.getByTestId('game-difficulty')).toContainText('従来のルール');
  await page.getByTestId('start-ops').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  await expect(page.getByTestId('card-weather')).toBeVisible();
  await expect(page.getByTestId('weather-level')).toHaveCount(0);
  await expect(page.getByTestId('weather-level-top')).toHaveCount(0);
  await expect(page.getByTestId('weather-forecast')).toHaveCount(0);
  await page.getByTestId('stop-ops').click();
  // 標準の新しいゲーム: 資金は従来の 4,000,000 cr、新しいルール（難易度 標準）
  await page.getByTestId('new-career').click();
  await expect(page.getByTestId('cash')).toContainText('4,000,000');
  await expect(page.getByTestId('game-difficulty')).toContainText('標準');
});

test('既存の会社に「ゲーム設定」で新しいルールを付け外しできる', async ({ page }) => {
  await expect(page.getByTestId('game-difficulty')).toContainText('従来のルール');
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('setup-difficulty-expert').check();
  await page.getByTestId('setup-apply').click();
  await expect(page.getByTestId('game-difficulty')).toContainText('上級');
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('setup-legacy').check();
  await page.getByTestId('setup-apply').click();
  await expect(page.getByTestId('game-difficulty')).toContainText('従来のルール');
});

test('悪天の日（段階 4）は段階が上部バー・天候カードに出て、運航表の行メニューから先行欠航できる', async ({ page }) => {
  test.setTimeout(90_000);
  await load(page, gameProject({ day: 10, difficulty: 'expert', climate: 'humid' }));
  await page.getByTestId('start-ops').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  await expect(page.getByTestId('weather-level')).toHaveAttribute('data-level', '4');
  await expect(page.getByTestId('weather-level-top')).toHaveAttribute('data-level', '4');
  await expect(page.getByTestId('weather-hourly')).toBeVisible();
  // まだ現れていない折り返しを先行欠航にする（運航を止めて行メニューを操作）
  await page.getByTestId('speed-0').click();
  const row = page.locator('table.fids-table tbody tr').last();
  const number = (await row.getAttribute('data-testid'))!.replace('flight-', '');
  await row.getByTestId(`fids-menu-${number}`).click();
  await page.getByTestId(`fids-cancel-${number}`).click();
  await expect(page.getByTestId('toast')).toContainText('先行欠航にしました');
});

test('振り返りの「明日の見通し」に天候の予報（3 区間）が出る', async ({ page }) => {
  test.setTimeout(90_000);
  await load(page, gameProject({ day: 6, difficulty: 'normal', nearMidnight: true }));
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  await page.getByTestId('speed-60').click();
  await expect(page.getByTestId('day-review')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('review-forecast')).toBeVisible();
  await expect(page.getByTestId('review-forecast-6')).toBeVisible();
  await expect(page.getByTestId('review-tomorrow')).not.toContainText('予報なし');
});
