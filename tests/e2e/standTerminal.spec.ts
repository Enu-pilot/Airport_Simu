import { expect, test, type Page } from '@playwright/test';
import { busTwoTerminalLayout } from '../audit/b_helpers';
import { createSandboxCompany } from '../../src/core/economy/company';
import { buildProject, serializeProject } from '../../src/core/io/project';
import { row } from './ui';

/** 1-11 / K-1 と Z-1: リモートスポットの所属ターミナルと、プロパティでのバス搭乗の変更 */
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

async function loadTwoTerminals(page: Page): Promise<{ t1: string; t2: string }> {
  const tt = busTwoTerminalLayout();
  const json = serializeProject(buildProject({ name: '2ターミナル', savedAt: '2026-01-01T00:00:00.000Z', layout: tt.layout, company: createSandboxCompany('e2e-standterm'), pin: null, scenarios: [], sim: null }));
  await page.getByTestId('tab-project').click();
  await page.getByTestId('project-file').setInputFiles({ name: 'two.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  await expect(page.getByTestId('project-report')).toContainText('読み込みました');
  return { t1: tt.t1, t2: tt.t2 };
}

test('Z-1: リモートスポットのバス搭乗・接続バスゲートをプロパティで変更でき、「値が不正です」にならない', async ({ page }) => {
  await loadTwoTerminals(page);
  await (await row(page, 'std_8')).click();
  await expect(page.getByTestId('prop-remoteBoarding')).toBeVisible();
  await page.getByTestId('prop-remoteBoarding').selectOption('bus');
  await expect(page.getByTestId('prop-remoteBoarding')).toHaveValue('bus');
  await expect(page.getByTestId('toast').filter({ hasText: '値が不正です' })).toHaveCount(0);
  await page.getByTestId('prop-busGateId').selectOption('fac_10');
  await expect(page.getByTestId('prop-busGateId')).toHaveValue('fac_10');
  await expect(page.getByTestId('toast').filter({ hasText: '値が不正です' })).toHaveCount(0);
  await page.getByTestId('prop-remoteBoarding').selectOption('none');
  await expect(page.getByTestId('prop-remoteBoarding')).toHaveValue('none');
  await expect(page.getByTestId('prop-standTerminal')).toHaveCount(0);
});

test('所属ターミナルを選ぶと、使うバスゲートの候補と表示が所属側に切り替わり、「自動」に戻せる', async ({ page }) => {
  const { t2 } = await loadTwoTerminals(page);
  await (await row(page, 'std_8')).click();
  const sel = page.getByTestId('prop-standTerminal');
  await expect(sel).toBeVisible();
  await expect(sel).toHaveValue('');
  await sel.selectOption(t2);
  await expect(sel).toHaveValue(t2);
  await expect(page.getByTestId('toast').filter({ hasText: '値が不正です' })).toHaveCount(0);
  // 自動割当: 選んだターミナル（B）のゲート fac_11 が使われる
  await expect(page.getByTestId('properties')).toContainText('ターミナルB');
  // 接続バスゲートの候補は、所属ターミナルのゲートだけ
  await page.getByTestId('prop-remoteBoarding').selectOption('bus');
  const options = await page.getByTestId('prop-busGateId').locator('option').allTextContents();
  expect(options.some((t) => t.includes('ターミナルB'))).toBe(true);
  expect(options.some((t) => t.includes('ターミナル ') && !t.includes('ターミナルB'))).toBe(false);
  // 自動に戻す（キーを消す）
  await sel.selectOption('');
  await expect(sel).toHaveValue('');
  await expect(page.getByTestId('toast').filter({ hasText: '値が不正です' })).toHaveCount(0);
});
