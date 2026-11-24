import { expect, test, type Page } from '@playwright/test';
import { addContract, createSandboxCompany } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { buildProject, serializeProject } from '../../src/core/io/project';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { settingsAction } from './settings';
import { openTab } from './ui';

/** フェーズ 3（3-07 / 3-08 の画面）: 路線需要モデルの設定・契約の座席と見込み搭乗率・路線の需要と供給 */
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

async function openPlan(page: Page) {
  await openTab(page, 'plan');
  await expect(page.getByTestId('plan-panel')).toBeVisible();
}

test('新規ゲーム: 路線需要モデルを有効にすると、契約に座席と見込み搭乗率、路線の需要と供給が出る', async ({ page }) => {
  await settingsAction(page, 'new-game-setup');
  await page.getByTestId('setup-mode-career').check();
  await expect(page.getByTestId('setup-city-enabled')).toBeChecked();
  await page.getByTestId('setup-market-enabled').check();
  await page.getByTestId('setup-start').click();
  await openPlan(page);
  await expect(page.getByTestId('traffic-routes')).toBeVisible();
  await expect(page.getByTestId('traffic-route-KTA')).toBeVisible();
  // 契約の座席・見込み搭乗率は「契約」タブの契約中の便に出る
  await openTab(page, 'contracts');
  await expect(page.getByTestId('contracts-panel')).toBeVisible();
  const seats = page.locator('[data-testid^="contract-seats-"]').first();
  await expect(seats).toBeVisible();
  await expect(page.locator('[data-testid^="contract-lf-"]').first()).toContainText('%');
});

test('market のプロジェクト（保存形式 5）: 新規の就航先（名古屋）の契約が読み込めて表示される', async ({ page }) => {
  const company = createSandboxCompany();
  company.city = defaultCity('core');
  company.market = { version: 1, routes: {} };
  const k = addContract(company, {
    airlineId: 'SK', destinationId: 'NGO', typeId: 'B787-9', perDay: 2, window: 'any',
    feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0,
  });
  const project = buildProject({ name: 'p3', savedAt: '2026-11-18T00:00:00.000Z', layout: createSampleAirport(), company, pin: null, scenarios: [], sim: null });
  expect(project.formatVersion).toBe(5);
  await openTab(page, 'project');
  await page.getByTestId('project-file').setInputFiles({ name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(serializeProject(project)) });
  await openTab(page, 'contracts');
  await expect(page.getByTestId('contracts-panel')).toBeVisible();
  await expect(page.getByTestId(`contract-${k.id}`)).toContainText('名古屋');
  await expect(page.getByTestId(`contract-seats-${k.id}`)).toHaveText('1160'); // 290 席 × 2 便 × 2（往復）。B787-9 の既定席数は PR #52 のカタログ更新で 266 → 290
  await expect(page.getByTestId(`contract-lf-${k.id}`)).toContainText('%');
  // 航空会社の一覧には market 専用の会社も出る
  await openTab(page, 'airlines');
  await expect(page.getByTestId('airlines-panel')).toContainText('ツバメエア');
});

test('market なしでは需要の欄は出ない', async ({ page }) => {
  await openPlan(page);
  await expect(page.getByTestId('traffic-routes')).toHaveCount(0);
  await expect(page.locator('[data-testid^="contract-seats-"]')).toHaveCount(0);
});
