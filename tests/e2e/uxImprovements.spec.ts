import { expect, test, type Page } from '@playwright/test';
import { openTab } from './ui';

/**
 * 操作性改善 UX-1〜8（docs/implementation/active/ui_usability_improvement_plan.md、2026-11-24 PO 指示で全導入）。
 * 発見 → 操作 → 状態の確認を利用者と同じ手順で行う。
 */
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

test('UX-1 ? キーとトップバーのボタンでショートカット一覧を開閉し、建設と運航で中身が切り替わる', async ({ page }) => {
  await page.getByTestId('map').hover();
  await page.keyboard.press('Shift+Slash'); // ?
  const help = page.getByTestId('shortcut-help');
  await expect(help).toBeVisible();
  await expect(help).toContainText('ショートカット一覧（建設）');
  await expect(help).toContainText('滑走路');
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  await page.getByTestId('page-operations').click();
  await page.getByTestId('shortcut-help-open').click();
  await expect(help).toContainText('ショートカット一覧（運航）');
  await expect(help).toContainText('×600');
  await page.getByTestId('shortcut-help-close').click();
  await expect(help).toHaveCount(0);
});

test('UX-2 W/O/Q/H/U でツールが切り替わり、ツールボタンにキーが表示される', async ({ page }) => {
  await page.getByTestId('map').hover();
  for (const [key, id] of [['w', 'runway'], ['o', 'facility:apron'], ['q', 'facility:gate'], ['h', 'facility:terminal'], ['u', 'road']] as const) {
    await page.keyboard.press(key);
    await expect(page.getByTestId(`tool-${id}`)).toHaveClass(/active/);
    await expect(page.getByTestId(`tool-key-${id}`)).toHaveText(key.toUpperCase());
  }
});

test('UX-3 使ったツールがクイックバーに並び、Shift+数字で呼び出せ、右クリックでピン留めでき、再読込後も残る', async ({ page }) => {
  await page.getByTestId('map').hover();
  await page.keyboard.press('w');
  await page.keyboard.press('t');
  await expect(page.getByTestId('quick-slot-1')).toContainText('誘導路');
  await expect(page.getByTestId('quick-slot-2')).toContainText('滑走路');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+Digit2');
  await expect(page.getByTestId('tool-runway')).toHaveClass(/active/);
  // 右クリックでピン留め → 先頭に固定
  await page.getByTestId('quick-slot-2').click({ button: 'right' });
  await expect(page.getByTestId('quick-slot-1')).toContainText('📌');
  await page.reload();
  await expect(page.getByTestId('map-canvas')).toBeVisible();
  await expect(page.getByTestId('quick-slot-1')).toContainText('📌');
  await page.getByTestId('quick-slot-1').click();
  await expect(page.locator('.tool.active').first()).toBeVisible();
});

test('UX-4 / でツール検索にフォーカスし、部分一致で絞り込み Enter で選べる', async ({ page }) => {
  await page.getByTestId('map').hover();
  await page.keyboard.press('/');
  await expect(page.getByTestId('tool-search')).toBeFocused();
  await page.keyboard.type('保安');
  await expect(page.getByTestId('tool-search-results')).toContainText('保安検査');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tool-area:security')).toHaveClass(/active/);
  await expect(page.getByTestId('tool-search')).toHaveValue('');
});

test('UX-5 運航ナビは 5 群の見出し付きで、各ボタンはワンクリックで開く', async ({ page }) => {
  await page.getByTestId('page-operations').click();
  for (const g of ['運航', '旅客・施設', '地上', '経営', '管理']) await expect(page.getByTestId(`ops-nav-group-${g}`)).toBeVisible();
  await expect(page.getByTestId('ops-nav-group-地上').getByTestId('tab-ground')).toBeVisible();
  await page.getByTestId('tab-ground').click();
  await expect(page.getByTestId('detail-overlay')).toBeVisible();
});

test('UX-6/UX-7 建設画面の下部は経営への近道 1 行で、押すと経営ボードの該当区分（4 群）を開く', async ({ page }) => {
  await expect(page.getByTestId('bottom-shortcuts')).toBeVisible();
  const row = (await page.getByTestId('bottom-shortcuts').boundingBox())!;
  expect(row.height).toBeLessThan(60); // 従来の下部タブ（約 170px）より低い
  await openTab(page, 'contracts');
  await expect(page.getByTestId('management-page')).toBeVisible();
  await expect(page.getByTestId('management-contracts')).toHaveClass(/active/);
  for (const g of ['需要と計画', '施設と能力', 'お金', '記録と管理']) await expect(page.getByTestId(`management-group-${g}`)).toBeVisible();
  await expect(page.getByTestId('management-group-施設と能力').getByTestId('management-workorders')).toBeVisible();
});

test('UX-8 空港能力は分野タブで切り替わり、ボトルネックは上位 5 件を上段に出す', async ({ page }) => {
  await page.getByTestId('page-management').click();
  await page.getByTestId('management-capacity').click();
  await expect(page.getByTestId('capacity-overall')).toBeVisible();
  await expect(page.getByTestId('capacity-facilities')).toHaveCount(0);
  await page.getByTestId('capacity-view-facilities').click();
  await expect(page.getByTestId('capacity-facilities')).toBeVisible();
  await expect(page.getByTestId('capacity-overall')).toHaveCount(0);
  const bottlenecks = page.getByTestId('capacity-bottlenecks');
  if (await bottlenecks.count()) expect(await bottlenecks.locator('.capacity-bottleneck').count()).toBeLessThanOrEqual(5);
});

test('UX-8 1366×768 では補助ボタンが「⋯」にまとまり、運航の左列の内部表示は折りたためる', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const more = page.getByTestId('top-more');
  await expect(more).toBeVisible();
  await expect(page.getByTestId('skip-day')).toBeHidden();
  await more.locator(':scope > summary').click();
  await expect(page.getByTestId('skip-day')).toBeVisible();
  await more.locator(':scope > summary').click();
  await page.getByTestId('page-operations').click();
  const fold = page.getByTestId('ops-fold-interior');
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
});
