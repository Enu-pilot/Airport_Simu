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
  await expect(page.getByTestId('capacity-facilities')).toBeVisible();
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
