import { expect, test, type Page } from '@playwright/test';

/**
 * 建物・階層の接続と UI で再現した不具合（docs/39 §10）。失敗するのが現状。
 * 画面サイズ 1920x1080 とサンプル空港の既定の表示に依存する。
 */
test.use({ viewport: { width: 1920, height: 1080 } });

const HANGAR = { x: 445, y: 275 };
const TERMINAL = { x: 770, y: 380 };
const EMPTY = { x: 600, y: 650 };

async function open(page: Page): Promise<void> {
  page.on('dialog', (d) => void d.accept());
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await page.waitForTimeout(600);
}
async function clickMap(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(80);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(250);
}
const facilityCount = async (page: Page): Promise<number> => Number(/施設 (\d+)/.exec((await page.getByTestId('status').textContent()) ?? '')?.[1] ?? NaN);
async function selectAt(page: Page, p: { x: number; y: number }): Promise<string> {
  await page.getByTestId('tool-select').click();
  await clickMap(page, p);
  return (await page.getByTestId('prop-title').count()) ? ((await page.getByTestId('prop-title').textContent()) ?? '') : '';
}
async function placeInside(page: Page, parent: string, tool: string, floor: string, at: { x: number; y: number }): Promise<void> {
  const parents = await page.getByTestId('facility-parent').locator('option').allTextContents();
  await page.getByTestId('facility-parent').selectOption({ label: parents.find((o) => o.includes(parent))! });
  await page.getByTestId(tool).click();
  await page.getByTestId('facility-floor').selectOption(floor);
  await clickMap(page, at);
}

// V-1: 明示能力の既定値 0（画面の説明は「0=未算出」）のまま道路を引くと「値が不正です」で必ず失敗する。
// src/editor/tools.ts:286・input.ts:80 が 0 をそのまま渡し、src/core/layout/operations.ts:552 が 0 以下を拒否する。
for (const roadClass of ['public', 'service', 'rail', 'walkway', 'fuel']) {
  test(`V-1 既定の設定のまま ${roadClass} を引ける`, async ({ page }) => {
    await open(page);
    await page.getByTestId('tool-road').click();
    await page.getByTestId('opt-roadClass').selectOption(roadClass);
    expect(await page.getByTestId('road-capacity').inputValue()).toBe('0');
    const cash = await page.getByTestId('cash').textContent();
    await clickMap(page, { x: 500, y: 600 });
    await clickMap(page, { x: 620, y: 600 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    expect(await page.getByTestId('toast').count() ? await page.getByTestId('toast').textContent() : '', 'エラー表示').not.toContain('値が不正です');
    expect(await page.getByTestId('cash').textContent(), '建設費が引かれる').not.toBe(cash);
  });
}

// V-3: 建物内に設備を置くと、その位置をクリックしても親の建物を選べなくなる（2D に表示されない内部設備が選ばれる）。
// src/core/layout/pick.ts は階層・内部設備・表示状態を見ない。
test('V-3 格納庫の中に設備を置いた後も、格納庫をクリックで選べる', async ({ page }) => {
  await open(page);
  expect(await selectAt(page, HANGAR)).toContain('格納庫');
  await placeInside(page, '格納庫', 'tool-facility:gseBase', '0', HANGAR);
  expect(await selectAt(page, HANGAR)).toContain('格納庫');
});

// V-4: 表示していない階層のものがクリックで選ばれる（地上を表示中に、地下 1 に置いた見えない施設が選ばれる）。
test('V-4 地上を表示中は、地下 1 階の施設（表示されていない）をクリックで選ばない', async ({ page }) => {
  await open(page);
  await page.getByTestId('map-level').selectOption('-1');
  await page.getByTestId('tool-facility:tower').click();
  await clickMap(page, EMPTY);
  await page.getByTestId('map-level').selectOption('0');
  expect(await selectAt(page, EMPTY)).toBe('');
});

// V-5: 置けない階を選んで配置しても何も起きず、理由も出ない（階の選択肢は親の階数にかかわらず 地下5階〜3階）。
test('V-5 1 階建ての格納庫で「2階」を選んで配置すると、置けない理由が表示される', async ({ page }) => {
  await open(page);
  const before = await facilityCount(page);
  await placeInside(page, '格納庫', 'tool-facility:gseBase', '1', HANGAR);
  expect(await facilityCount(page)).toBe(before);
  await expect(page.getByTestId('toast')).toBeVisible({ timeout: 2000 });
});

// V-6: 2 階建てのターミナルでも「3F」を選べ、エリアをドラッグしても何も起きず理由も出ない。
test('V-6 2 階建てターミナルの 3F にエリアを置こうとすると、置けない理由が表示される', async ({ page }) => {
  await open(page);
  await page.getByTestId('level-2').click();
  await page.getByTestId('tool-area:waiting').click();
  await page.mouse.move(TERMINAL.x + 60, TERMINAL.y - 10);
  await page.mouse.down();
  await page.mouse.move(TERMINAL.x + 110, TERMINAL.y + 15, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('toast')).toBeVisible({ timeout: 2000 });
});
