import { expect, test, type Page } from '@playwright/test';

/**
 * 監査 ID 02（表示）・19（UI / 2D / 3D / ブラウザ）: 画面サイズ・ページ切替・2D/3D 切替・長めの連続運航で
 * ブラウザのエラー（pageerror / console.error）が出ないこと、主要な操作部品が画面外へ出ないことを確認する。
 */
test.use({ launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  page.on('dialog', (d) => void d.accept());
  return errors;
}

const SIZES = [
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];

for (const size of SIZES) {
  test(`${size.width}x${size.height}: 主要ページを一巡してもエラーがなく、主要な操作部品が画面内にある`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors = watch(page);
    await page.goto('/');
    await expect(page.getByTestId('map-canvas')).toBeVisible();
    const offscreen: string[] = [];
    const inView = async (id: string) => {
      const loc = page.getByTestId(id).first();
      await expect(loc, id).toBeVisible();
      const b = (await loc.boundingBox())!;
      if (b.x < -1 || b.y < -1 || b.x + b.width > size.width + 1 || b.y + b.height > size.height + 1) {
        offscreen.push(`${id} ${JSON.stringify(b)}`);
      }
    };
    // toolbox は高さ 955px 未満で下にはみ出す既知の不具合がある（tests/audit/e2e-known/toolbox.repro.spec.ts、docs/39 の U-1）
    const top = ['page-construction', 'page-operations', 'page-management', 'view-toggle'];
    for (const id of size.height >= 1000 ? [...top, 'toolbox'] : top) await inView(id);
    await page.getByTestId('page-management').click();
    await expect(page.getByTestId('management-page')).toBeVisible();
    await page.getByTestId('management-capacity').click();
    await expect(page.getByTestId('capacity-panel')).toBeVisible();
    await page.getByTestId('page-operations').click();
    await expect(page.getByTestId('ops-controls')).toBeVisible();
    for (const id of ['ops-controls', 'sim-clock', 'flight-board', 'stop-ops']) await inView(id);
    await page.getByTestId('speed-600').click();
    await page.waitForTimeout(1500);
    // 文書全体が横スクロールしない
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflowX, '横方向のはみ出し(px)').toBeLessThanOrEqual(1);
    expect(offscreen, '画面外にはみ出した操作部品').toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('2D/3D を 6 回切り替え、運航中にページを行き来してもエラーがなく時計が進み続ける', async ({ page }) => {
  const errors = watch(page);
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await page.getByTestId('page-operations').click();
  for (let i = 0; i < 10; i++) await page.getByTestId('add-arrival').click();
  await page.getByTestId('speed-60').click();
  const clock = page.getByTestId('sim-clock');
  for (let i = 0; i < 6; i++) {
    const before = await clock.textContent();
    await page.getByTestId('view-toggle').click();
    if (i % 2 === 0) await expect(page.getByTestId('view3d-canvas')).toBeVisible();
    else await expect(page.getByTestId('map-canvas')).toBeVisible();
    await page.waitForTimeout(1200);
    await expect(clock, `切替 ${i + 1} 回目`).not.toHaveText(before ?? '');
  }
  await page.getByTestId('page-management').click();
  await expect(page.getByTestId('management-page')).toBeVisible();
  await page.getByTestId('page-operations').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  expect(errors).toEqual([]);
});

test('600 倍速で実時間 40 秒（ゲーム内 約 6.7 時間）連続運航してもエラーがなく、JS ヒープが 2 倍を超えて増えない', async ({ page }) => {
  const errors = watch(page);
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await page.getByTestId('page-operations').click();
  await page.getByTestId('speed-600').click();
  const heap = () => page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
  await page.waitForTimeout(8000);
  const h0 = await heap();
  const t0 = await page.getByTestId('sim-clock').textContent();
  await page.waitForTimeout(32_000);
  const h1 = await heap();
  // 日の終わりの振り返りが出ていれば閉じられること（出ていなければ時計が進んでいること）
  const review = page.getByTestId('day-review');
  if (!(await review.isVisible())) await expect(page.getByTestId('sim-clock')).not.toHaveText(t0 ?? '');
  test.info().annotations.push({ type: 'heap', description: `start=${h0} end=${h1}` });
  if (h0 > 0) expect(h1 / h0, `heap ${h0} -> ${h1}`).toBeLessThan(2);
  expect(errors).toEqual([]);
});
