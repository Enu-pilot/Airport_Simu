import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto('/');
  await expect(page.getByTestId('map-canvas')).toBeVisible();
});

test('主要ページを切り替え、能力画面と設定メニューへ移動できる', async ({ page }) => {
  await page.getByTestId('page-management').click();
  await expect(page.getByTestId('management-page')).toBeVisible();
  await page.getByTestId('management-capacity').click();
  await expect(page.getByTestId('capacity-panel')).toBeVisible();
  // UX-8: 空港能力は分野タブで切り替える（概要が既定）
  await expect(page.getByTestId('capacity-overall')).toBeVisible();
  await page.getByTestId('capacity-view-facilities').click();
  await expect(page.getByTestId('capacity-facilities')).toBeVisible();
  await page.getByTestId('capacity-view-preview').click();
  await expect(page.getByTestId('capacity-preview')).toBeVisible();

  const menu = page.getByTestId('settings-menu');
  await expect(menu.getByTestId('new-career')).toBeHidden();
  await menu.locator('summary').click();
  await expect(menu.getByTestId('new-career')).toBeVisible();
});

test('建設・経営ページへ移動している間も運航シミュレーションは進む', async ({ page }) => {
  await page.getByTestId('page-operations').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  await page.getByTestId('speed-600').click();
  const clock = page.getByTestId('sim-clock');
  const before = await clock.textContent();
  await page.getByTestId('page-management').click();
  await expect(page.getByTestId('management-page')).toBeVisible();
  await page.getByTestId('page-construction').click();
  await expect(page.getByText('運航中は空港構造を変更できません')).toBeVisible();
  await page.waitForTimeout(600);
  await page.getByTestId('page-operations').click();
  await expect(clock).not.toHaveText(before ?? '', { timeout: 5_000 });
  await expect(page.getByTestId('stop-ops')).toBeVisible();
});

test('能力画面に、空港全体の離発着能力のカードと、制約になっている要素の名前が出る（1-19）', async ({ page }) => {
  await page.getByTestId('page-management').click();
  await page.getByTestId('management-capacity').click();
  const overall = page.getByTestId('capacity-overall');
  await expect(overall).toBeVisible();
  await expect(overall).toContainText('空港全体の離発着能力');
  await expect(overall).toContainText('回/時');
  await expect(page.getByTestId('capacity-overall-limit')).toContainText(/制約: (滑走路|スポットの回転数|折り返し能力|未算出)/);
  // 誘導路は未算出であることを根拠に明記する
  await expect(overall).toContainText('誘導路は未算出');
});

test('運航中に滑走路を閉鎖すると、能力画面は閉鎖を反映する（1-19 / AS-5）', async ({ page }) => {
  await page.getByTestId('page-operations').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  await page.getByTestId('tab-disruptions').click();
  await page.getByTestId('disruption-kind').selectOption('runwayClosed');
  await page.getByTestId('disruption-add').click();
  await page.getByTestId('overlay-close').click();
  await page.getByTestId('page-management').click();
  await page.getByTestId('management-capacity').click();
  await expect(page.getByTestId('capacity-panel')).toContainText('運航中の閉鎖を反映');
  await expect(page.getByTestId('capacity-overall')).toBeVisible();
});
