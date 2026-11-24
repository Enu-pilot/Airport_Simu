import { expect, test, type Page } from '@playwright/test';
import { createSandboxCompany } from '../../src/core/economy/company';
import { buildProject, serializeProject } from '../../src/core/io/project';
import { addRoadPath, connectRoadLevels, createEmptyLayout } from '../../src/core/layout/operations';
import { createSite } from '../../src/core/model/site';
import { openBuildPanel, openTab, row, tool } from './ui';

/**
 * 建物・階層の接続と UI（docs/39 §10。V-1・V-3〜V-6・W-6・W-8 の修正後の回帰、フェーズ 1 の 1-01・1-03〜1-05）。
 * 画面サイズ 1920x1080 とサンプル空港の既定の表示に依存する。
 */
test.use({ viewport: { width: 1920, height: 1080 } });

// 画面上の点は、既定のカメラ（左上 (10, 20)・9px/タイル）と地図の表示位置からタイル座標で求める
// （画面構成の再編で地図の表示位置が変わっても、同じ施設を指すように。open() で更新する）
const CAM = { x: 10, y: 20, zoom: 9 };
const HANGAR_TILE = { x: 33, y: 41 }; // サンプル空港の格納庫（origin (31, 39)）の内側
const TERMINAL_TILE = { x: 56, y: 52 }; // 旅客ターミナル（origin (46, 49)・48×8）の左寄り。右へ 60〜110px のドラッグも建物内に収まる
const EMPTY_TILE = { x: 30, y: 75 }; // 道路・駐車場から離れた空き地
let HANGAR = { x: 0, y: 0 };
let TERMINAL = { x: 0, y: 0 };
let EMPTY = { x: 0, y: 0 };
async function resolvePoints(page: Page): Promise<void> {
  const box = (await page.getByTestId('map').boundingBox())!;
  const px = (t: { x: number; y: number }) => ({ x: box.x + (t.x + 0.5 - CAM.x) * CAM.zoom, y: box.y + (t.y + 0.5 - CAM.y) * CAM.zoom });
  HANGAR = px(HANGAR_TILE);
  TERMINAL = px(TERMINAL_TILE);
  EMPTY = px(EMPTY_TILE);
}

async function open(page: Page): Promise<void> {
  page.on('dialog', (d) => void d.accept());
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await page.waitForTimeout(600);
  await resolvePoints(page);
}
async function clickMap(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(80);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(250);
}
const facilityCount = async (page: Page): Promise<number> => Number(/施設 (\d+)/.exec((await page.getByTestId('status').textContent()) ?? '')?.[1] ?? NaN);
async function selectAt(page: Page, p: { x: number; y: number }): Promise<string> {
  await (await tool(page, 'select')).click();
  await clickMap(page, p);
  return (await page.getByTestId('prop-title').count()) ? ((await page.getByTestId('prop-title').textContent()) ?? '') : '';
}
async function placeInside(page: Page, parent: string, toolTestId: string, floor: string, at: { x: number; y: number }): Promise<void> {
  const parents = await page.getByTestId('facility-parent').locator('option').allTextContents();
  await page.getByTestId('facility-parent').selectOption({ label: parents.find((o) => o.includes(parent))! });
  await (await tool(page, toolTestId.replace(/^tool-/, ''))).click();
  await page.getByTestId('facility-floor').selectOption(floor);
  await clickMap(page, at);
}

// V-1: 明示能力の既定値 0（画面の説明は「0=未算出」）のまま道路を引くと「値が不正です」で必ず失敗する。
// src/editor/tools.ts:286・input.ts:80 が 0 をそのまま渡し、src/core/layout/operations.ts:552 が 0 以下を拒否する。
for (const roadClass of ['public', 'service', 'rail', 'walkway', 'fuel']) {
  test(`V-1 既定の設定のまま ${roadClass} を引ける`, async ({ page }) => {
    await open(page);
    await (await tool(page, 'road')).click();
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
  await (await tool(page, 'facility:tower')).click();
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
  await expect(page.getByTestId('toast')).toContainText('建物の階数の範囲外');
});

// V-6: 2 階建てのターミナルでも「3F」を選べ、エリアをドラッグしても何も起きず理由も出ない。
test('V-6 2 階建てターミナルの 3F にエリアを置こうとすると、置けない理由が表示される', async ({ page }) => {
  await open(page);
  await page.getByTestId('level-2').click();
  await (await tool(page, 'area:waiting')).click();
  await page.mouse.move(TERMINAL.x + 60, TERMINAL.y - 10);
  await page.mouse.down();
  await page.mouse.move(TERMINAL.x + 110, TERMINAL.y + 15, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('toast')).toBeVisible({ timeout: 2000 });
  await expect(page.getByTestId('toast')).toContainText('建物の階数の範囲外');
});

// ---- フェーズ 1（1-03・1-04・1-05）の追加ケース

// 重なった候補は、プロパティの選択欄で切り替える（クリックを循環させない）
test('1-03 内部表示がオン・階が一致すると、内部設備と親の建物が候補になり、選択欄で切り替えられる', async ({ page }) => {
  await open(page);
  await placeInside(page, '格納庫', 'tool-facility:gseBase', '0', HANGAR);
  await (await tool(page, 'select')).click();
  // 内部表示をオフにしている間は、親の建物だけが選ばれ、選択欄は出ない
  await clickMap(page, HANGAR);
  await expect(page.getByTestId('prop-title')).toContainText('格納庫');
  await expect(page.getByTestId('pick-candidates')).toHaveCount(0);
  // 内部表示（1F = floorIndex 0）をオンにする
  await page.getByTestId('level-0').click();
  await clickMap(page, HANGAR);
  const chooser = page.getByTestId('pick-candidates');
  await expect(chooser).toBeVisible();
  const buttons = chooser.locator('button');
  expect(await buttons.count()).toBeGreaterThanOrEqual(2);
  expect(await page.getByTestId('prop-title').textContent()).not.toContain('格納庫');
  await chooser.locator('button', { hasText: '格納庫' }).click();
  await expect(page.getByTestId('prop-title')).toContainText('格納庫');
  await expect(chooser).toBeVisible();
});

test('1-03 建物の子の一覧から内部設備を選べ、階を変更できる（V-3・W-6）', async ({ page }) => {
  await open(page);
  await placeInside(page, '格納庫', 'tool-facility:gseBase', '0', HANGAR);
  await (await tool(page, 'select')).click();
  await clickMap(page, HANGAR);
  await expect(page.getByTestId('prop-title')).toContainText('格納庫');
  const children = page.getByTestId('interior-children');
  await expect(children).toBeVisible();
  await children.locator('button').first().click();
  await expect(page.getByTestId('prop-title')).not.toContainText('格納庫');
  await expect(page.getByTestId('prop-floorIndex')).toHaveValue('0');
});

test('1-04 ターミナルの子の階を、プロパティで 1F から 2F に変更できる（W-6）', async ({ page }) => {
  await open(page);
  await placeInside(page, 'ターミナル', 'tool-facility:gseBase', '0', TERMINAL);
  await (await tool(page, 'select')).click();
  await clickMap(page, TERMINAL);
  await expect(page.getByTestId('prop-title')).toContainText('ターミナル');
  await page.getByTestId('interior-children').locator('button').first().click();
  const floor = page.getByTestId('prop-floorIndex');
  await expect(floor).toHaveValue('0');
  await floor.selectOption('1');
  await expect(floor).toHaveValue('1');
  await expect(page.getByTestId('toast')).toHaveCount(0);
});

test('1-04 親の階数を超える階には「この建物にはありません」と表示される', async ({ page }) => {
  await open(page);
  const parents = await page.getByTestId('facility-parent').locator('option').allTextContents();
  await page.getByTestId('facility-parent').selectOption({ label: parents.find((o) => o.includes('格納庫'))! });
  const texts = await page.getByTestId('facility-floor').locator('option').allTextContents();
  // 階の表記は階層表示統一（PR #62）で「1F（床 0m／地図階層 0）」形式。1 階建ての格納庫では 1F に注記がなく、2F には付く
  expect(texts.find((t) => t.startsWith('1F'))).toBeDefined();
  expect(texts.find((t) => t.startsWith('1F'))).not.toContain('この建物にはありません');
  expect(texts.find((t) => t.startsWith('2F'))).toContain('この建物にはありません');
});

// W-8: 内部名（baggageSort など）が画面に出ない
test('1-05 建物の配置先の選択肢は内部名でなく和名で表示する', async ({ page }) => {
  await open(page);
  const texts = await page.getByTestId('facility-parent').locator('option').allTextContents();
  expect(texts.length).toBeGreaterThan(1);
  for (const key of ['baggageSort', 'gseBase', 'fuelFarm', 'hangar', 'terminal']) {
    expect(texts.filter((t) => t.includes(key + ' ') || t.startsWith(key)), key).toEqual([]);
  }
});

test('1-05 階層接続設備は和名（階段）で表示される', async ({ page }) => {
  let l = createEmptyLayout(createSite({ width: 80, height: 60, offsiteMargin: 0 }), 'conn');
  const ok = <T extends { ok: boolean }>(r: T): T => {
    if (!r.ok) throw new Error('op failed');
    return r;
  };
  const unwrap = (r: ReturnType<typeof addRoadPath>) => (ok(r) as { ok: true; layout: typeof l }).layout;
  l = unwrap(addRoadPath(l, [{ x: 10, y: 10 }, { x: 20, y: 10 }], { roadClass: 'walkway', level: 0, capacityPerHour: 600 }));
  l = unwrap(addRoadPath(l, [{ x: 20, y: 10 }, { x: 30, y: 10 }], { roadClass: 'walkway', level: -1, capacityPerHour: 600 }));
  const at = (lv: number) => Object.values(l.roadNodes).find((n) => (n.level ?? 0) === lv && n.pos.x === 20 && n.pos.y === 10)!.id;
  l = unwrap(connectRoadLevels(l, at(-1), at(0), { roadClass: 'walkway', connectorKind: 'stairs' }));
  const connector = Object.values(l.roads).find((e) => e.connectorKind)!;
  const json = serializeProject(buildProject({ name: '階段', savedAt: '2026-01-01T00:00:00.000Z', layout: l, company: createSandboxCompany('e2e-conn'), pin: null, scenarios: [], sim: null }));
  await open(page);
  await openTab(page, 'project');
  await page.getByTestId('project-file').setInputFiles({ name: 'conn.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  await expect(page.getByTestId('project-report')).toContainText('読み込みました');
  await openBuildPanel(page, 'facilities');
  await page.locator('.list-group-title', { hasText: '道路' }).click();
  await (await row(page, `${connector.id}`)).click();
  await expect(page.getByTestId('prop-title')).toContainText('階段');
  await expect((await row(page, `${connector.id}`))).toContainText('階段');
});
