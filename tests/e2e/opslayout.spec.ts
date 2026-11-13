import { expect, test, type Page } from '@playwright/test';

/** 12B-1: 運航モードの画面（常設カード・案内板風の運航表・アラート・大きなオーバーレイ・航空会社の評価） */

const uncaught = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  page.on('pageerror', (e) => list.push(e.message));
  page.on('dialog', (d) => void d.accept());
  uncaught.set(page, list);
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(uncaught.get(page)).toEqual([]);
});

async function startOps(page: Page) {
  await page.getByTestId('start-ops').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
}

/** 要素が画面（ビューポート）に収まっている */
async function expectInViewport(page: Page, testId: string) {
  const box = (await page.getByTestId(testId).boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box, testId).not.toBeNull();
  expect(box.x, `${testId} x`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${testId} y`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${testId} right`).toBeLessThanOrEqual(vp.width + 1);
  expect(box.y + box.height, `${testId} bottom`).toBeLessThanOrEqual(vp.height + 1);
}

test('運航モードは常設のカードと右上の運航表を出し、建設用のツールボックスは出さない', async ({ page }) => {
  await startOps(page);
  for (const id of ['kpi', 'runway', 'weather', 'construction', 'terminal', 'ground', 'access', 'airline', 'events']) {
    await expect(page.getByTestId(`card-${id}`), id).toBeVisible();
  }
  await expect(page.getByTestId('today-kpi-otp')).toBeVisible();
  await expect(page.getByTestId('card-runway').getByTestId(/^runway-rwy/).first()).toBeVisible();
  await expect(page.getByTestId('flight-board')).toBeVisible();
  await expect(page.getByTestId('toolbox')).toHaveCount(0);
  await expect(page.getByTestId('ops-nav')).toBeVisible();
  // 運航表だけが table.board（カードは div で組む）
  await expect(page.locator('table.board')).toHaveCount(1);
  await expect(page.locator('table.board')).toHaveClass(/fids/);
  // 下部の詳細は何も選んでいないと畳まれている
  await expect(page.getByTestId('aircraft-panel')).toHaveCount(0);
  for (const id of ['flight-board', 'ops-controls', 'ops-detail', 'ops-left', 'ops-right']) await expectInViewport(page, id);
  // 本日の KPI カードの見出しから、経営の詳細が大きなオーバーレイで開く
  await page.getByTestId('card-kpi-open').click();
  await expect(page.getByTestId('finance-panel')).toBeVisible();
  await page.getByTestId('overlay-close').click();
  await expect(page.getByTestId('detail-overlay')).toHaveCount(0);
});

test('運航表は出発・到着を切り替えられ、折りたためる。行クリックで機体を選択する', async ({ page }) => {
  await startOps(page);
  // 負荷が高いと「到着処理中」の間にゲーム内時間が進んで状態の文言が変わってしまうので、実時間（×1）で進めてから確かめる
  await page.getByTestId('speed-1').click();
  await page.getByTestId('add-arrival').click();
  const rows = page.locator('table.fids-table tbody tr');
  await expect(rows.filter({ hasText: '到着処理中' }).first()).toBeVisible();
  await page.getByTestId('fids-filter-departure').click();
  await expect(rows.first()).toBeVisible();
  await expect(rows.filter({ hasText: 'FROM' })).toHaveCount(0);
  await page.getByTestId('fids-filter-arrival').click();
  await expect(rows.filter({ hasText: 'TO ' })).toHaveCount(0);
  await expect(rows.filter({ hasText: '到着処理中' }).first()).toBeVisible();
  await page.getByTestId('fids-filter-all').click();

  // 折りたたみ: 見出しだけ残る
  await page.getByTestId('fids-fold').click();
  await expect(page.locator('table.fids-table')).toHaveCount(0);
  await expect(page.getByTestId('flight-board')).toBeVisible();
  await page.getByTestId('fids-fold').click();
  await expect(rows.first()).toBeVisible();

  // 行クリックで機体を選択すると、下部に詳細が出る
  await rows.filter({ hasText: '到着処理中' }).first().click();
  await expect(page.getByTestId('aircraft-panel')).toBeVisible();
  await expect(page.getByTestId('ops-detail').getByTestId('aircraft-history')).toContainText('到着処理中');
  await expectInViewport(page, 'ops-detail');
  // 全列表示（上部の「運航表（全列）」）でも同じ表のまま列が増える
  await page.getByTestId('tab-flights').click();
  await expect(page.locator('table.fids-table thead')).toContainText('滑走路');
  await expect(page.locator('table.board')).toHaveCount(1);
});

test('運航表の行から遅延・優先を直接操作できる', async ({ page }) => {
  await startOps(page);
  await page.getByTestId('add-arrival').click();
  const row = page.locator('table.fids-table tbody tr', { hasText: '到着処理中' }).first();
  const number = (await row.getAttribute('data-testid'))!.replace('flight-', '');
  // 手動で足した便の便名は契約の便と重なることがある（既存の挙動）ので、行の中のボタンを押す
  await row.getByTestId(`fids-menu-${number}`).click();
  await expect(page.getByTestId(`fids-stand-${number}`).locator('select')).toBeEnabled();
  await page.getByTestId(`fids-delay15-${number}`).click();
  await expect(page.getByTestId('toast')).toContainText('15分遅らせました');
  // 遅らせた分が運航表の遅延に出る（予想時刻が 15 分後になる）。操作しても行の選択は変わらない
  await expect(page.getByTestId('aircraft-panel')).toHaveCount(0);
  await page.getByTestId(`fids-prio-${number}`).click();
  await expect(page.getByTestId('toast')).toContainText('地上作業を優先します');
  await page.getByTestId(`fids-prio-${number}`).click();
  await expect(page.getByTestId('toast')).toContainText('優先を解除しました');
});

test('滑走路閉鎖の障害でアラートが出て、クリックで移動し、修理ボタンで解除できる', async ({ page }) => {
  await startOps(page);
  await page.getByTestId('tab-disruptions').click();
  await page.getByTestId('disruption-kind').selectOption('runwayClosed');
  await page.getByTestId('disruption-add').click();
  await page.getByTestId('overlay-close').click();
  const stack = page.getByTestId('alert-stack');
  await expect(stack).toBeVisible();
  const alert = stack.locator('[data-testid^="alert-disruption:runwayClosed"]').first();
  await expect(alert).toContainText('一時閉鎖');
  await expect(alert).toContainText('重大');
  // 天候・障害カードにも発生中の障害が出る
  await expect(page.getByTestId('card-weather')).toContainText('一時閉鎖');
  // クリックでその滑走路へ移動（選択）し、下部に詳細が出る
  await alert.getByRole('button', { name: /一時閉鎖/ }).click();
  await expect(page.getByTestId('prop-title')).toBeVisible();
  await expect(page.getByTestId('ops-detail')).toContainText('滑走路');
  // 修理ボタン（既存の disruptionActions.resolve）で解除され、アラートが消える
  await alert.locator('[data-testid^="alert-act-repair"]').click();
  await expect(page.getByTestId('toast')).toContainText('修理・解除しました');
  await expect(stack).toHaveCount(0);
});

test('あまり使わないパネルは大きなオーバーレイで開き、閉じるボタン・Esc・同じボタンで閉じる。時計と倍率は覆わない', async ({ page }) => {
  await startOps(page);
  await page.getByTestId('tab-analytics').click();
  await expect(page.getByTestId('detail-overlay')).toBeVisible();
  await expect(page.getByTestId('analytics-panel')).toBeVisible();
  const ov = (await page.getByTestId('detail-overlay').boundingBox())!;
  const left = (await page.getByTestId('ops-controls').boundingBox())!;
  expect(ov.width).toBeGreaterThan(900);
  expect(ov.x).toBeGreaterThanOrEqual(left.x + left.width - 1); // 左列は覆わない
  // 開いたままでも時計・倍率・停止が押せる
  await page.getByTestId('speed-240').click();
  await expect(page.getByTestId('speed-240')).toHaveClass(/active/);
  await expect(page.getByTestId('stop-ops')).toBeVisible();
  await page.getByTestId('overlay-close').click();
  await expect(page.getByTestId('detail-overlay')).toHaveCount(0);
  await page.getByTestId('tab-finance').click();
  await expect(page.getByTestId('finance-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('detail-overlay')).toHaveCount(0);
  await page.getByTestId('tab-events').click();
  await expect(page.getByTestId('event-log')).toBeVisible();
  await page.getByTestId('tab-events').click();
  await expect(page.getByTestId('detail-overlay')).toHaveCount(0);
});

test('航空会社の評価カードが点数と「足りないもの」を表示する（キャリア）', async ({ page }) => {
  await page.getByTestId('new-career').click();
  await expect(page.getByTestId('company-badge')).toContainText('キャリア');
  await startOps(page);
  await expect(page.getByTestId('card-airline-RJ')).toBeVisible();
  await expect(page.getByTestId('card-airline-lacking-RJ')).toContainText('足りないもの');
  // 料金を上げると料金が足りないものに出る（評価は表示のみ。会社の状態は変わらない）
  await page.getByTestId('card-airline-open').click();
  const panel = page.getByTestId('airline-score-RJ');
  await expect(panel).toBeVisible();
  for (const k of ['otp', 'turnaround', 'stand', 'fees', 'slots', 'aircraft', 'pax']) await expect(panel.getByTestId(`airline-score-RJ-${k}`)).toBeVisible();
  await expect(panel.getByTestId('airline-score-RJ-fees')).toContainText('良好');
  await expect(panel.getByTestId('airline-lacking-RJ')).toContainText('足りないもの');
  await page.getByTestId('overlay-close').click();
  await page.getByTestId('tab-finance').click();
  await page.getByTestId('overlay-close').click();
  await page.getByTestId('tab-plan').click();
  await page.getByTestId('fee-terminal').evaluate((el: HTMLInputElement) => {
    // React の制御コンポーネントのスライダーを 2.0 にする
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(el, '2');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByTestId('overlay-close').click();
  await page.getByTestId('tab-airlines').click();
  await expect(page.getByTestId('airline-score-RJ-fees')).toContainText(/注意|不足/);
  await expect(page.getByTestId('airline-lacking-RJ')).toContainText('料金');
});

test('建設モードの画面は従来のまま（ツールボックス・下部タブ・プロパティ）', async ({ page }) => {
  for (const id of ['toolbox', 'undo', 'redo', 'tab-issues', 'tab-plan', 'tab-finance', 'tab-project', 'properties', 'facility-list', 'status']) await expect(page.getByTestId(id), id).toBeVisible();
  await expect(page.getByTestId('ops-nav')).toHaveCount(0);
  await expect(page.getByTestId('flight-board')).toHaveCount(0);
  await expect(page.getByTestId('detail-overlay')).toHaveCount(0);
  // 運航 → 建設に戻ると、また従来の画面
  await startOps(page);
  await page.getByTestId('stop-ops').click();
  await expect(page.getByTestId('toolbox')).toBeVisible();
  await expect(page.getByTestId('tab-issues')).toBeVisible();
  await expect(page.getByTestId('ops-nav')).toHaveCount(0);
});

for (const size of [
  { width: 1400, height: 900 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test(`画面幅 ${size.width}px で運航表・運航コントロール・詳細・左右の列が画面に収まる`, async ({ page }) => {
    await page.setViewportSize(size);
    await startOps(page);
    await page.getByTestId('add-arrival').click();
    await page.locator('table.fids-table tbody tr', { hasText: '到着処理中' }).first().click();
    await expect(page.getByTestId('aircraft-panel')).toBeVisible();
    for (const id of ['flight-board', 'ops-controls', 'ops-detail', 'ops-left', 'ops-right', 'sim-clock', 'stop-ops']) await expectInViewport(page, id);
    // 運航表と左列・右列は重ならない
    const fids = (await page.getByTestId('flight-board').boundingBox())!;
    const left = (await page.getByTestId('ops-left').boundingBox())!;
    const right = (await page.getByTestId('ops-right').boundingBox())!;
    expect(fids.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
    expect(fids.x + fids.width).toBeLessThanOrEqual(right.x + 1);
    // 全列表示にしても中央に収まる
    await page.getByTestId('tab-flights').click();
    const full = (await page.getByTestId('flight-board').boundingBox())!;
    expect(full.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
    expect(full.x + full.width).toBeLessThanOrEqual(right.x + 1);
  });
}
