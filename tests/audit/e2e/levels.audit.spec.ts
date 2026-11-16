import { expect, test, type Page } from '@playwright/test';

/**
 * 監査（docs/39 §10）: 建物・階層の接続と UI。現状で成り立つことの確認（合格するテスト）。
 * 画面サイズ 1920x1080 とサンプル空港の既定の表示（格納庫・旅客ターミナルの位置）に依存する。
 */
test.use({ viewport: { width: 1920, height: 1080 }, launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

const HANGAR = { x: 445, y: 275 };
const TERMINAL = { x: 770, y: 380 };

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  page.on('dialog', (d) => void d.accept());
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await page.waitForTimeout(600);
  return errors;
}
async function clickMap(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(80);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(250);
}
const facilityCount = async (page: Page): Promise<number> => Number(/施設 (\d+)/.exec((await page.getByTestId('status').textContent()) ?? '')?.[1] ?? NaN);

test('建物内に設備を置ける（格納庫 1 階・ターミナル 2 階）。配置先の一覧は建物だけ', async ({ page }) => {
  const errors = await open(page);
  const before = await facilityCount(page);
  const parents = await page.getByTestId('facility-parent').locator('option').allTextContents();
  expect(parents.some((o) => o.includes('格納庫'))).toBe(true);
  expect(parents.some((o) => o.includes('旅客ターミナル'))).toBe(true);
  expect(parents.some((o) => o.includes('駐車場') || o.includes('エプロン'))).toBe(false);
  await page.getByTestId('facility-parent').selectOption({ label: parents.find((o) => o.includes('格納庫'))! });
  await page.getByTestId('tool-facility:gseBase').click();
  await page.getByTestId('facility-floor').selectOption('0');
  await clickMap(page, HANGAR);
  expect(await facilityCount(page)).toBe(before + 1);
  await page.getByTestId('facility-parent').selectOption({ label: parents.find((o) => o.includes('旅客ターミナル'))! });
  await page.getByTestId('tool-facility:baggageSort').click();
  await page.getByTestId('facility-floor').selectOption('1');
  await clickMap(page, TERMINAL);
  expect(await facilityCount(page)).toBe(before + 2);
  // 建物内の設備は「建物内配置」として親と階が表示される
  await page.getByTestId('tool-select').click();
  // 1-03（V-3 の修正）: 内部表示がオフのときのクリックは親の建物を選ぶ（以前は表示されない内部設備が選ばれていた）。
  // 内部設備は親のプロパティの「建物内の設備」一覧から選び、親と階は「建物内配置（親）」の階の選択欄で表示する（1-04）。
  await clickMap(page, HANGAR);
  await page.getByTestId('interior-children').locator('button').first().click();
  await expect(page.getByTestId('properties')).toContainText('建物内配置（格納庫');
  await expect(page.getByTestId('prop-floorIndex')).toHaveValue('0');
  expect(errors).toEqual([]);
});

test('明示能力を入れれば地上と地下 1 に通路を引け、ノードのプロパティから階層接続設備を建設できる', async ({ page }) => {
  const errors = await open(page);
  const cash = () => page.getByTestId('cash').textContent();
  await page.getByTestId('tool-road').click();
  await page.getByTestId('opt-roadClass').selectOption('walkway');
  await page.getByTestId('road-capacity').fill('600');
  await page.getByTestId('tool-road').click();
  const c0 = await cash();
  await clickMap(page, { x: 500, y: 600 });
  await clickMap(page, { x: 620, y: 600 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const c1 = await cash();
  expect(c1).not.toBe(c0);
  await page.getByTestId('map-level').selectOption('-1');
  await page.getByTestId('tool-road').click();
  await clickMap(page, { x: 620, y: 600 });
  await clickMap(page, { x: 760, y: 600 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect(await cash()).not.toBe(c1);
  await page.getByTestId('tool-select').click();
  await clickMap(page, { x: 620, y: 600 });
  await expect(page.getByTestId('properties')).toContainText('交通階層');
  const panel = page.getByTestId('road-layer-connect');
  await expect(panel).toBeVisible();
  await panel.locator('select').first().selectOption({ index: 1 });
  await panel.locator('button.primary').click();
  await expect(page.getByTestId('properties')).toContainText('接続（2）');
  expect(errors).toEqual([]);
});

test('階層の表示を地下 5〜高架 10・全レイヤに切り替え、3D でも切り替えてもエラーが出ない', async ({ page }) => {
  const errors = await open(page);
  const levels = await page.getByTestId('map-level').locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
  expect(levels).toEqual(['all', ...Array.from({ length: 16 }, (_, i) => String(i - 5))]);
  for (const l of levels) await page.getByTestId('map-level').selectOption(l);
  await page.getByTestId('view-toggle').click();
  await expect(page.getByTestId('view3d-canvas')).toBeVisible();
  for (const l of ['-1', '0', '2', 'all']) {
    await page.getByTestId('map-level').selectOption(l);
    await page.waitForTimeout(700);
  }
  await page.getByTestId('view-toggle').click();
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  expect(errors).toEqual([]);
});
