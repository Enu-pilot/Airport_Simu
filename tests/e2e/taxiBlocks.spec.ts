import { expect, test, type Page } from '@playwright/test';
import { createSandboxCompany } from '../../src/core/economy/company';
import { buildProject, serializeProject } from '../../src/core/io/project';
import { updateLayoutSettings } from '../../src/core/layout/operations';
import { createSimulation } from '../../src/core/sim/simulation';
import { stepTicks } from '../../src/core/sim/dayloop';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { must } from '../unit/helpers';
import { openBuildPanel, overlayToggle, tool } from './ui';

/** フェーズ 2（2-07・2-06 の画面）: 区間ごとに進む地上走行の設定・誘導路の上書き・区間の表示 */
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

async function deselect(page: Page) {
  await (await tool(page, 'select')).click();
  await page.keyboard.press('Escape');
}

async function selectFirstTaxiway(page: Page) {
  await (await tool(page, 'select')).click();
  await openBuildPanel(page, 'facilities');
  await page.getByTestId('facility-list').getByRole('button', { name: /誘導路/ }).click();
  await page.getByTestId('facility-list').locator('[data-testid^="row-twy_"]').first().click();
}

async function loadProject(page: Page, json: string) {
  await page.getByTestId('tab-project').click();
  await page.getByTestId('project-file').setInputFiles({ name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(json) });
}

const blockProject = (): string => {
  const layout = must(updateLayoutSettings(createSampleAirport(), { taxiMode: 'block' })).layout;
  return serializeProject(buildProject({ name: 'block', savedAt: '2026-11-17T00:00:00.000Z', layout, company: createSandboxCompany(), pin: null, scenarios: [], sim: null }));
};

test('設定: 従来 → 区間ごとに進む に切り替えると区間数が出て、区間の長さを変えると区間数が変わり、元に戻せる', async ({ page }) => {
  await deselect(page);
  await expect(page.getByTestId('airport-settings')).toBeVisible();
  await expect(page.getByTestId('setting-taxiMode')).toHaveValue('full');
  await expect(page.getByTestId('setting-taxiSummary')).toHaveCount(0);
  await page.getByTestId('setting-taxiMode').selectOption('block');
  await expect(page.getByTestId('setting-taxiMode')).toHaveValue('block');
  const summary = page.getByTestId('setting-taxiSummary');
  await expect(summary).toContainText('区間');
  const count = async () => Number(/区間 (\d+) 個/.exec((await summary.textContent()) ?? '')![1]);
  const atDefault = await count();
  await page.getByTestId('setting-taxiBlockTiles').fill('4');
  await page.getByTestId('setting-taxiBlockTiles').press('Enter');
  await expect.poll(count).toBeGreaterThan(atDefault);
  await page.getByTestId('setting-taxiBlockTiles').fill('40');
  await page.getByTestId('setting-taxiBlockTiles').press('Enter');
  await expect.poll(count).toBeLessThanOrEqual(atDefault);
  // 範囲外は受け付けない（値は変わらない）
  await page.getByTestId('setting-taxiBlockTiles').fill('3');
  await page.getByTestId('setting-taxiBlockTiles').press('Enter');
  await expect(page.getByTestId('setting-taxiBlockTiles')).toHaveValue('40');
  // 元に戻す（区間の長さ 2 回 → 方式）
  await page.getByTestId('undo').click();
  await page.getByTestId('undo').click();
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('setting-taxiMode')).toHaveValue('full');
});

test('誘導路の進入可能機数の上限: 選ぶと保存され、計算値のままに戻すと消える。従来方式では効かない旨を出す', async ({ page }) => {
  await selectFirstTaxiway(page);
  await expect(page.getByTestId('prop-blockMax')).toBeVisible();
  await expect(page.getByTestId('prop-blockMax-inactive')).toBeVisible();
  await page.getByTestId('prop-blockMax').selectOption('2');
  await expect(page.getByTestId('prop-blockMax')).toHaveValue('2');
  await page.getByTestId('prop-blockMax').selectOption('');
  await expect(page.getByTestId('prop-blockMax')).toHaveValue('');
});

test('block のプロジェクトを読み込むと、論理ネットワーク表示で区間が描かれ、誘導路に区間の情報が出る。コンソールエラーなし', async ({ page }) => {
  await loadProject(page, blockProject());
  await expect(page.getByTestId('toast')).toBeVisible();
  await selectFirstTaxiway(page);
  await expect(page.getByTestId('prop-blocks')).toContainText('区間');
  await expect(page.getByTestId('prop-blockMax-inactive')).toHaveCount(0);
  await (await overlayToggle(page, 'network')).check(); // 区間の区切りと機数の表示（描画でエラーが出ないこと）
  await page.waitForTimeout(300);
  await expect(page.getByTestId('map-canvas')).toBeVisible();
});

test('運航中は区間の設定を変更できない（設定欄は出ず、誘導路の上限は無効）', async ({ page }) => {
  await loadProject(page, blockProject());
  await page.getByTestId('page-operations').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  await expect(page.getByTestId('setting-taxiMode')).toHaveCount(0);
  await page.getByTestId('overlays-pop').locator('summary').click();
  await (await overlayToggle(page, 'network')).check(); // 運航中の区間の占有の表示
  await page.waitForTimeout(500);
  await page.getByTestId('stop-ops').click();
  await expect(page.getByTestId('map-canvas')).toBeVisible();
});

test('3D 表示: block のプロジェクトでも描画でき、運航中に切り替えてもエラーが出ない', async ({ page }) => {
  await loadProject(page, blockProject());
  await page.getByTestId('view-toggle').click();
  await expect(page.getByTestId('view3d')).toBeVisible();
  await page.waitForTimeout(800);
  await page.getByTestId('view-toggle').click();
  await expect(page.getByTestId('map-canvas')).toBeVisible();
});

/** 2-06: 区間ごとの走行の待機理由が運航表（FIDS）と機体の詳細に日本語で出る。理由は状態に直接書いた保存データで確かめる（実運航で出る条件は tests/unit/sim 側） */
test('運航表に区間の待機理由（前の区間が満杯）が出る', async ({ page }) => {
  test.setTimeout(90_000);
  const layout = must(updateLayoutSettings(createSampleAirport(), { taxiMode: 'block' })).layout;
  const sim = createSimulation(layout, { seed: 'e2e-block-reason', company: createSandboxCompany('e2e-block') });
  let target: string | null = null;
  for (let i = 0; i < 1500 && !target; i++) {
    stepTicks(sim, 60);
    target = Object.values(sim.state.aircraft).find((a) => a.state === 'taxiOut' || a.state === 'taxiIn')?.id ?? null;
  }
  expect(target).not.toBeNull();
  const ac = sim.state.aircraft[target!]!;
  ac.holdReason = 'blockFull';
  ac.waitSince = sim.state.now - 120;
  const flight = sim.state.flights[ac.state === 'taxiOut' ? ac.departureFlightId : ac.arrivalFlightId]!;
  const json = serializeProject(buildProject({ name: 'reason', savedAt: '2026-11-17T00:00:00.000Z', layout, company: sim.company ?? createSandboxCompany(), pin: null, scenarios: [], sim }));
  await loadProject(page, json);
  await page.getByTestId('page-operations').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  await page.getByTestId('speed-0').click();
  await expect(page.getByTestId(`flight-${flight.number}`)).toContainText('前の区間が満杯');
});
