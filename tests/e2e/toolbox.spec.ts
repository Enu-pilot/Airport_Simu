import { expect, test } from '@playwright/test';

/**
 * U-1（docs/39、修正済み 1-06）: 建設画面左のツール箱は画面高に応じて内部スクロールできる。
 * 折りたたみ分類をすべて展開した状態でも、全サイズで各ツールにマウス操作で到達できることを確認する。
 */
for (const size of [
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test(`${size.width}x${size.height}: ツール箱の全ボタンにホイール操作で到達できる`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(page.getByTestId('toolbox')).toBeVisible();
    // 折りたたみで隠れている分類も含め、全ツールを展開して従来のスクロール到達性を検査する。
    await page.locator('[data-testid=toolbox] details.tool-group').evaluateAll((groups) => {
      groups.forEach((group) => { (group as HTMLDetailsElement).open = true; });
    });
    await page.mouse.move(100, 400);
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 300);
    await page.waitForTimeout(300);
    const unreachable = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid=toolbox] button')]
        .filter((b) => b.getBoundingClientRect().bottom > window.innerHeight)
        .map((b) => b.getAttribute('data-testid') ?? b.textContent ?? ''),
    );
    expect(unreachable, '画面の下に隠れたままのボタン').toEqual([]);
  });
}


test('建設ツールの分類をアコーディオンで開閉できる', async ({ page }) => {
  await page.goto('/');
  const toolbox = page.getByTestId('toolbox');
  const group = toolbox.locator('details.tool-group').filter({
    has: toolbox.getByText('滑走路・誘導路', { exact: true }),
  });
  const summary = group.locator('summary');

  await expect(summary).toBeVisible();
  if (await group.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await summary.click();
  }
  await expect(page.getByTestId('tool-runway')).toBeHidden();

  await summary.click();
  await expect(page.getByTestId('tool-runway')).toBeVisible();
  await summary.click();
  await expect(page.getByTestId('tool-runway')).toBeHidden();

  // 配置オプションは分類の開閉に関係なく利用できる。
  await expect(page.getByTestId('map-level')).toBeVisible();

  // summaryは標準のdetails要素なので、キーボードからも再展開できる。
  await summary.focus();
  await summary.press('Enter');
  await expect(page.getByTestId('tool-runway')).toBeVisible();
});
