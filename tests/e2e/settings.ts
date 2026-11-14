import type { Page } from '@playwright/test';

/** Open a settings action through the deliberately collapsed global menu. */
export async function settingsAction(page: Page, testId: string): Promise<void> {
  const menu = page.getByTestId('settings-menu');
  if (!(await menu.evaluate((node) => (node as HTMLDetailsElement).open))) await menu.locator('summary').click();
  await page.getByTestId(testId).click();
}
