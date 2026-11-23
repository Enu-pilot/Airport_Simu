import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { row } from './ui';

/** 12B-3a: リモートスポット・ランプバスによるバス搭乗・独立ゲート（docs/29） */

const FIXTURE = fileURLToPath(new URL('./fixtures/bus-project.json', import.meta.url));
const uncaught = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  page.on('pageerror', (e) => list.push(e.message));
  page.on('console', (m) => m.type() === 'error' && list.push(m.text()));
  page.on('dialog', (d) => void d.accept());
  uncaught.set(page, list);
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(uncaught.get(page)).toEqual([]);
});

async function loadBusProject(page: Page) {
  await page.getByTestId('tab-project').click();
  await page.getByTestId('project-file').setInputFiles(FIXTURE);
  await expect(page.getByTestId('project-report')).toContainText('読み込みました');
}

async function startOps(page: Page) {
  await page.getByTestId('page-operations').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
}

test('ゲートの搭乗方式をバスにすると紐付けスポットが消え、ランプバスを足すと警告が消える', async ({ page }) => {
  await (await row(page, 'fac_6')).click();
  await page.getByTestId('prop-boardingMode').selectOption('bus');
  await expect(page.getByTestId('prop-standId')).toHaveCount(0);
  await expect(page.getByTestId('prop-bus-targets')).toContainText('リモートスポット');
  await expect(page.getByTestId('properties')).toContainText('ランプバスがありません');
  await (await row(page, 'fac_14')).click();
  const buses = page.getByTestId('prop-apronBuses');
  await buses.fill('2');
  await buses.press('Enter');
  await (await row(page, 'fac_6')).click();
  await expect(page.getByTestId('properties')).not.toContainText('ランプバスがありません');
});

test('独立ゲート: 接続先のあるゲートは警告が出ず、未接続は出る。接続先を選ぶと消える', async ({ page }) => {
  await loadBusProject(page);
  await (await row(page, 'fac_11')).click();
  await expect(page.getByTestId('properties')).toContainText('ターミナルに接していません');
  await (await row(page, 'fac_10')).click();
  await expect(page.getByTestId('properties')).not.toContainText('ターミナルに接していません');
  await (await row(page, 'fac_11')).click();
  await page.getByTestId('prop-connectedTo').selectOption('fac_2');
  await expect(page.getByTestId('properties')).not.toContainText('ターミナルに接していません');
});

test('リモートスポットの便がバスで搭乗・降機し、運航表に BUS が出る', async ({ page }) => {
  test.setTimeout(240_000);
  await loadBusProject(page);
  await startOps(page);
  for (let i = 0; i < 3; i++) await page.getByTestId('add-arrival').click();
  await page.getByTestId('speed-600').click();
  // 運航表: バス扱いの便に BUS の札が付く
  await expect(page.locator('[data-testid^="fids-bus-"]').first()).toBeVisible({ timeout: 90_000 });
  // 地上支援のカード: ランプバスの運行が完了する
  await expect(page.getByTestId('ground-apronBus')).toContainText(/完了 [1-9]/, { timeout: 150_000 });
  // 全列表示で、BUS の便の旅客が降機・退出（到着）／搭乗（出発）できている（全員が乗り遅れ・到達不能にならない）
  await page.getByTestId('tab-flights').click();
  await expect
    .poll(
      async () => {
        const rows = page.locator('table.fids-table tbody tr', { has: page.locator('[data-testid^="fids-bus-"]') });
        const texts = await rows.locator('[data-testid^="pax-"]').allTextContents();
        const exited = texts.some((t) => /退出 [1-9]/.test(t));
        const boarded = texts.some((t) => /搭乗(中|締切) [1-9]/.test(t));
        return exited && boarded;
      },
      { timeout: 150_000 },
    )
    .toBe(true);
});

test('ランプバスが故障して足りなくなると、不足のアラートが出る', async ({ page }) => {
  test.setTimeout(240_000);
  await loadBusProject(page);
  await startOps(page);
  for (let i = 0; i < 3; i++) await page.getByTestId('add-arrival').click();
  await page.getByTestId('tab-ground').click();
  const board = page.getByTestId('ground-board');
  const rows = board.locator('tr', { hasText: 'ランプバス gu_' });
  await expect(rows).toHaveCount(3);
  for (let i = 0; i < 3; i++) await rows.nth(i).getByRole('button', { name: '故障' }).click();
  await page.getByTestId('overlay-close').click();
  await page.getByTestId('speed-600').click();
  // 出し分け（決定C）: 警告はアラートスタックではなく要対応インボックスに出る（src/ui/operate/AlertStack.tsx）
  await expect(page.getByTestId('alert-inbox-note')).toBeVisible({ timeout: 150_000 });
  await page.getByTestId('rail-attention').click();
  await expect(page.getByTestId('attention')).toContainText('ランプバス不足', { timeout: 30_000 });
});
