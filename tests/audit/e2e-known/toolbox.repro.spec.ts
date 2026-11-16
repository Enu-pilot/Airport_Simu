import { expect, test } from '@playwright/test';

/**
 * 既知の不具合 U-1 の再現（docs/39）: 画面の高さが約 955px 未満だと、建設ページ左のツール箱が下にはみ出し、
 * スクロールもできない（.left / .toolbox に overflow 指定がなく body は overflow: hidden。src/ui/styles.css:79,91）。
 * 期待: すべての建設ツールにマウス操作で到達できる。実際: 下の方のボタン（鉄道駅・職員駐車場・ホテル・用地・階層切替）に届かない。
 */
for (const size of [
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
]) {
  test(`${size.width}x${size.height}: ツール箱の全ボタンにホイール操作で到達できる`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(page.getByTestId('toolbox')).toBeVisible();
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
