import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

// 3D は WebGL が必要。ヘッドレスでは SwiftShader（ソフトウェア描画）で動かす
test.use({ launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

test('2D/3D を切り替えても運航は止まらず、3D に機体が表示され性能値が計測される', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await page.getByTestId('start-ops').click();
  for (let i = 0; i < 20; i++) await page.getByTestId('add-arrival').click();
  await page.getByTestId('speed-60').click();
  await page.getByTestId('view-toggle').click();
  await expect(page.getByTestId('view3d-canvas')).toBeVisible();
  const t0 = await page.getByTestId('sim-clock').textContent();
  await expect(page.getByTestId('perf-3d')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(5000);
  const stats = await page.evaluate(() => window.__skyport3d!);
  expect(stats.aircraft).toBeGreaterThan(0);
  expect(stats.fps).toBeGreaterThan(0);
  // 切り替えてもシミュレーションの時刻は進み続ける
  await expect(page.getByTestId('sim-clock')).not.toHaveText(t0!);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/perf-3d.json', JSON.stringify({ measuredAt: new Date().toISOString(), renderer: 'SwiftShader (software)', ...stats }, null, 2));
  await page.getByTestId('view-toggle').click();
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  expect(errors).toEqual([]);
});

test('3D で施設をクリックするとプロパティに詳細が出て、何もない所をクリックすると選択が外れる', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('view-toggle').click();
  const c = page.getByTestId('view3d-canvas');
  await expect(c).toBeVisible();
  await page.waitForTimeout(1000);
  const b = (await c.boundingBox())!;
  // 初期の視点は 2D の表示範囲の中心（サンプル空港のターミナル）を見下ろす
  await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.5);
  await expect(page.getByTestId('properties')).toContainText('旅客ターミナル');
  await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.6);
  await expect(page.getByTestId('properties')).toContainText('施設を選択すると');
});
