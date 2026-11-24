import type { Page } from '@playwright/test';

/** Open a settings action through the deliberately collapsed global menu. */
export async function settingsAction(page: Page, testId: string): Promise<void> {
  // 経営ボードが開いていれば閉じてから（UX-7 で建設画面の経営タブはボードを開くようになった）
  const close = page.getByTestId('board-close');
  if (await close.isVisible().catch(() => false)) await close.click();
  const menu = page.getByTestId('settings-menu');
  if (!(await menu.evaluate((node) => (node as HTMLDetailsElement).open))) await menu.locator('summary').click();
  await page.getByTestId(testId).click();
}
