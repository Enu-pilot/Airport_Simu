import { expect, test, type Page } from '@playwright/test';
import { settingsAction } from './settings';

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

const status = (page: Page) => page.getByTestId('status');

test('保存したプロジェクトを開くと、変更前の空港・会社に戻る', async ({ page }) => {
  await page.getByTestId('tab-project').click();
  await page.getByTestId('project-name').fill('テスト空港');
  await page.getByTestId('project-save').click();
  await expect(page.getByTestId('project-slot-テスト空港')).toBeVisible();
  await expect(status(page)).toContainText('滑走路 1');
  await settingsAction(page, 'new-empty');
  await expect(status(page)).toContainText('滑走路 0');
  await page.getByTestId('project-slot-テスト空港').getByTestId('project-load').click();
  await expect(status(page)).toContainText('滑走路 1');
  await expect(page.getByTestId('project-report')).toContainText('読み込みました');
  await expect(page.getByTestId('project-versions')).toContainText('保存時の値で固定');
});

test('運航中に保存すると運航状態を含み、開くと同じ時刻から一時停止で再開する', async ({ page }) => {
  test.setTimeout(90_000);
  await page.getByTestId('page-operations').click();
  await page.getByTestId('speed-600').click();
  await expect(page.getByTestId('stat-arrivals')).not.toHaveText('0', { timeout: 45_000 });
  await page.keyboard.press('Space');
  const clock = await page.getByTestId('sim-clock').textContent();
  const arrivals = await page.getByTestId('stat-arrivals').textContent();
  await page.getByTestId('tab-project').click();
  await page.getByTestId('project-name').fill('運航中');
  await page.getByTestId('project-save').click();
  await expect(page.getByTestId('project-slot-運航中')).toContainText('あり');
  await page.getByTestId('stop-ops').click();
  await expect(page.getByTestId('page-operations')).toBeVisible();
  await page.getByTestId('tab-project').click();
  await page.getByTestId('project-slot-運航中').getByTestId('project-load').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  await expect(page.getByTestId('sim-clock')).toHaveText(clock!);
  await expect(page.getByTestId('stat-arrivals')).toHaveText(arrivals!);
  // 一時停止で再開するので時刻は進まない。再生すると進む
  await page.waitForTimeout(500);
  await expect(page.getByTestId('sim-clock')).toHaveText(clock!);
  await page.getByTestId('speed-60').click();
  await expect(page.getByTestId('sim-clock')).not.toHaveText(clock!);
});

test('壊れたファイル・参照切れのファイルは読み込まず、開いているプロジェクトを変えない', async ({ page }) => {
  await settingsAction(page, 'new-empty');
  await expect(status(page)).toContainText('滑走路 0');
  await page.getByTestId('tab-project').click();
  await page.getByTestId('project-file').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{ not json') });
  await expect(page.getByTestId('project-errors')).toContainText('JSON');
  await expect(status(page)).toContainText('滑走路 0');
  const json = await page.evaluate(() => {
    const p = { format: 'skyport-project', formatVersion: 1, name: 'x', versions: {}, layout: { name: 'x' }, company: {}, catalog: { version: 'x', models: {} }, scenarios: [], sim: null };
    return JSON.stringify(p);
  });
  await page.getByTestId('project-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  await expect(page.getByTestId('project-errors')).toContainText('レイアウト');
  await expect(status(page)).toContainText('滑走路 0');
});

test('JSON に書き出したファイルを読み込むと同じ空港に戻る', async ({ page }) => {
  await page.getByTestId('tab-project').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('project-export').click()]);
  const path = await download.path();
  expect(download.suggestedFilename()).toMatch(/\.skyport\.json$/);
  await settingsAction(page, 'new-empty');
  await expect(status(page)).toContainText('滑走路 0');
  await page.getByTestId('project-file').setInputFiles(path!);
  await expect(page.getByTestId('project-report')).toContainText('読み込みました');
  await expect(status(page)).toContainText('滑走路 1');
});

test('保存時の機種データが古いプロジェクトは、差分を確認してから最新カタログを適用できる', async ({ page }) => {
  await page.getByTestId('tab-project').click();
  await page.getByTestId('project-name').fill('古い機種データ');
  await page.getByTestId('project-save').click();
  // 保存データの機種データを古い版に書き換える（カタログ更新前に保存した状態を再現）
  await page.evaluate(() => {
    const index = JSON.parse(localStorage.getItem('skyport.projects.v1')!) as { id: string }[];
    const key = `skyport.project.v1.${index[0]!.id}`;
    const p = JSON.parse(localStorage.getItem(key)!);
    p.catalog.version = '2025.01.0';
    p.catalog.models['B777-300ER'].defaultSeats = 290;
    localStorage.setItem(key, JSON.stringify(p));
  });
  await page.getByTestId('project-slot-古い機種データ').getByTestId('project-load').click();
  await expect(page.getByTestId('project-warnings')).toContainText('2025.01.0');
  await expect(page.getByTestId('catalog-pin')).toContainText('差分があります');
  await page.getByTestId('catalog-diff-toggle').click();
  await expect(page.getByTestId('catalog-diff')).toContainText('B777-300ER');
  await expect(page.getByTestId('catalog-diff')).toContainText('defaultSeats');
  await page.getByTestId('catalog-apply-latest').click();
  await expect(page.getByTestId('project-versions')).toContainText('最新カタログ');
});
