import { expect, test, type Page } from '@playwright/test';
import { settingsAction } from './settings';
import { createSandboxCompany } from '../../src/core/economy/company';
import { buildProject, serializeProject } from '../../src/core/io/project';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSimulation } from '../../src/core/sim/simulation';
import { stepTicks } from '../../src/core/sim/dayloop';
import { DAY_SEC } from '../../src/core/sim/rules';

/**
 * 1 日のループ（12B-2）: 0:00 の自動一時停止と振り返り、1 日スキップ、日ごとの履歴。
 * 0:00 を実時間で待たないよう、0:00 の少し前まで進めた運航状態つきのプロジェクトを作って読み込む。
 */

const uncaught = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  page.on('pageerror', (e) => list.push(e.message));
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

/** 0:00 の 20 秒前まで進めたサンプル空港の運航（一時停止で再開する） */
function nearMidnight(): string {
  const layout = createSampleAirport();
  const sim = createSimulation(layout, { seed: 'e2e-dayloop', company: createSandboxCompany('e2e-dayloop') });
  stepTicks(sim, DAY_SEC - 20 - sim.state.now);
  return serializeProject(buildProject({ name: '0時前', savedAt: '2026-01-01T00:00:00.000Z', layout, company: sim.company!, pin: null, scenarios: [], sim }));
}

/**
 * 1 日分のシミュレーションを進める計算（テスト側の CPU 処理、負荷の高い環境では 5 秒前後）を、テストごとの 30 秒の枠から外す。
 * ワーカーごとに 1 回だけ beforeAll で作る（1-17: dayloop:47 の不安定の原因。製品側の競合ではなく、枠の大半を fixture の計算が使っていた）。
 */
let midnightProject: string | null = null;
test.beforeAll(() => {
  test.setTimeout(120_000);
  midnightProject = nearMidnight();
});

async function loadNearMidnight(page: Page) {
  await page.getByTestId('tab-project').click();
  await page.getByTestId('project-file').setInputFiles({ name: 'midnight.json', mimeType: 'application/json', buffer: Buffer.from(midnightProject ?? nearMidnight()) });
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  await expect(page.getByTestId('sim-clock')).toContainText('1日目 23:59');
}

test('0:00 で自動的に一時停止し、収支・定時率・明日の見通しなどの振り返りが出る。「次の日へ」で 2 日目の朝から続く', async ({ page }) => {
  await loadNearMidnight(page);
  await page.getByTestId('speed-60').click();
  const review = page.getByTestId('day-review');
  await expect(review).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('review-title')).toHaveText('1日目の振り返り');
  await expect(page.getByTestId('today-kpi-delay')).toBeVisible();
  await expect(page.getByTestId('today-kpi-actual-delay')).toBeVisible();
  await expect(page.getByTestId('review-revenue-total')).toContainText('cr');
  await expect(page.getByTestId('review-cost-total')).toContainText('cr');
  await expect(page.getByTestId('review-otp-value')).toContainText('%');
  await expect(page.getByTestId('review-causes')).toBeVisible();
  await expect(page.getByTestId('review-disruptions')).toBeVisible();
  await expect(page.getByTestId('review-flights')).toBeVisible();
  const issueFlights = page.getByTestId('review-flights').locator('details.review-flight');
  if (await issueFlights.count()) {
    await issueFlights.first().locator('summary').click();
    await expect(issueFlights.first().locator('.review-flight-detail')).toBeVisible();
    await expect(issueFlights.first()).toContainText('到着遅延（実績 / 評価対象）');
    await expect(issueFlights.first()).toContainText('運航時系列');
  }
  await expect(page.getByTestId('review-compare')).toContainText('最初の日');
  await expect(page.getByTestId('review-airlines')).toBeVisible();
  await expect(page.getByTestId('review-tomorrow-flights')).toContainText('便');
  await expect(page.getByTestId('review-tomorrow')).toContainText('予報なし');
  // 上部バーは残り、時計は 0:00 の直後で止まっている
  await expect(page.getByTestId('stop-ops')).toBeVisible();
  const clock = await page.getByTestId('sim-clock').textContent();
  await page.waitForTimeout(400);
  expect(await page.getByTestId('sim-clock').textContent()).toBe(clock);

  await page.getByTestId('review-next').click();
  await expect(review).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('sim-clock')).toContainText('2日目');
  await expect(page.getByTestId('company-day')).toHaveText('2日目');
  await expect(page.getByTestId('speed-60')).toHaveClass(/active/);
  // 時間が進み続ける
  const t = await page.getByTestId('sim-clock').textContent();
  await expect(page.getByTestId('sim-clock')).not.toHaveText(t!);
});

test('締めの直後に「建設モードに戻る」と、空の日報を作らず、日は 1 だけ進む', async ({ page }) => {
  await loadNearMidnight(page);
  await page.getByTestId('speed-60').click();
  await expect(page.getByTestId('day-review')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('review-build').click();
  await expect(page.getByTestId('page-operations')).toBeVisible();
  await expect(page.getByTestId('day-review')).toBeHidden();
  await expect(page.getByTestId('company-day')).toHaveText('2日目');
  await page.getByTestId('tab-finance').click();
  const reports = page.getByTestId('reports');
  await expect(reports).toContainText('1日目');
  await expect(reports).not.toContainText('（途中）');
  await expect(reports.locator('tbody tr')).toHaveCount(1);
  // 前日の振り返りは建設モードからも読み取り専用で見られる
  await page.getByTestId('open-review').click();
  await expect(page.getByTestId('day-review')).toBeVisible();
  await expect(page.getByTestId('review-next')).toBeHidden();
  await page.getByTestId('review-close').click();
  await expect(page.getByTestId('day-review')).toBeHidden();
});

test('設定で「0:00 で一時停止」を切ると止まらずに 2 日目へ続き、「前日の振り返り」から見られる', async ({ page }) => {
  await loadNearMidnight(page);
  await page.getByText('⚙ 日の設定').click();
  await page.getByTestId('pref-pause-at-close').uncheck();
  await page.getByText('⚙ 日の設定').click();
  await page.getByTestId('speed-60').click();
  await expect(page.getByTestId('sim-clock')).toContainText('2日目', { timeout: 15_000 });
  await expect(page.getByTestId('day-review')).toBeHidden();
  await expect(page.getByTestId('speed-60')).toHaveClass(/active/);
  await page.getByTestId('open-review').click();
  await expect(page.getByTestId('review-title')).toHaveText('1日目の振り返り');
  await page.getByTestId('review-next').click();
  await expect(page.getByTestId('day-review')).toBeHidden();
  await expect(page.getByTestId('speed-60')).toHaveClass(/active/);
});

test('途中で建設モードに戻る（stop-ops）は従来どおりその日を途中で締める', async ({ page }) => {
  await page.getByTestId('page-operations').click();
  await page.getByTestId('speed-600').click();
  await expect(page.getByTestId('stat-arrivals')).not.toHaveText('0', { timeout: 45_000 });
  await page.getByTestId('stop-ops').click();
  await expect(page.getByTestId('toast')).toContainText('1日目を締めました');
  await page.getByTestId('tab-finance').click();
  await expect(page.getByTestId('reports')).toContainText('1日目（途中）');
});

test('1 日スキップ: 進捗バーが出て、締めの振り返りが出る。次の日へ進むと 2 日目の朝から続く。所要時間を記録', async ({ page }) => {
  test.setTimeout(180_000);
  await settingsAction(page, 'new-sandbox');
  await page.getByTestId('page-operations').click();
  await expect(page.getByTestId('ops-controls')).toBeVisible();
  const t0 = Date.now();
  await page.getByTestId('skip-day').click();
  await expect(page.getByTestId('skip-overlay')).toBeVisible();
  await expect(page.getByTestId('skip-progress')).toBeVisible();
  await expect(page.getByTestId('day-review')).toBeVisible({ timeout: 120_000 });
  const sec = (Date.now() - t0) / 1000;
  test.info().annotations.push({ type: 'skip-day-seconds', description: sec.toFixed(1) });
  console.log(`skip-day (sample airport, headless Chromium): ${sec.toFixed(1)} s`);
  expect(sec).toBeLessThan(60);
  await expect(page.getByTestId('skip-overlay')).toBeHidden();
  await expect(page.getByTestId('review-title')).toHaveText('1日目の振り返り');
  await expect(page.getByTestId('review-revenue-total')).not.toHaveText('0 cr');
  await page.getByTestId('review-next').click();
  await expect(page.getByTestId('day-review')).toBeHidden({ timeout: 60_000 });
  await expect(page.getByTestId('sim-clock')).toContainText('2日目');
  await expect(page.getByTestId('company-day')).toHaveText('2日目');
});

test('スキップを中止すると、その時刻で一時停止の運航になり、振り返りは出ない', async ({ page }) => {
  await settingsAction(page, 'new-sandbox');
  await page.getByTestId('page-operations').click();
  await page.getByTestId('skip-day').click();
  await expect(page.getByTestId('skip-overlay')).toBeVisible();
  await page.getByTestId('skip-cancel').click();
  await expect(page.getByTestId('skip-overlay')).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId('day-review')).toBeHidden();
  await expect(page.getByTestId('speed-0')).toHaveClass(/active/);
  await expect(page.getByTestId('company-day')).toHaveText('1日目');
  await expect(page.getByTestId('toast')).toContainText('スキップを中止');
});

test('日ごとの履歴: 締めるたびに「その日の朝」が残り、一覧から戻せる。壊れた履歴は読み込まず現在を変えない・削除できる', async ({ page }) => {
  test.setTimeout(180_000);
  await loadNearMidnight(page);
  await page.getByTestId('speed-60').click();
  await expect(page.getByTestId('day-review')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('review-next').click();
  await expect(page.getByTestId('day-review')).toBeHidden({ timeout: 30_000 });
  // 2 日目をスキップして、もう一度締める
  await page.getByTestId('skip-day').click();
  await expect(page.getByTestId('day-review')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('review-title')).toHaveText('2日目の振り返り');
  // 振り返りから履歴を開ける（運航中は戻れない）
  await page.getByTestId('review-history').click();
  await expect(page.getByTestId('history-row-1')).toBeVisible();
  await expect(page.getByTestId('history-row-2')).toBeVisible();
  await expect(page.getByTestId('history-overlay').getByTestId('history-restore-1')).toBeDisabled();
  await page.getByTestId('history-close').click();
  await page.getByTestId('review-build').click();
  await expect(page.getByTestId('company-day')).toHaveText('3日目');

  // 履歴（プロジェクトのパネルにも同じ一覧）から 2 日目の朝に戻す
  await page.getByTestId('tab-project').click();
  await expect(page.getByTestId('project-history').getByTestId('history-row-2')).toBeVisible();
  await page.getByTestId('open-history').click();
  await expect(page.getByTestId('history-overlay').getByTestId('history-row-1')).toContainText('2日目の朝');

  // 壊れた履歴を IndexedDB に直接入れる → 戻せず、現在の状態は変わらない
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const r = indexedDB.open('skyport');
        r.onsuccess = () => {
          const tx = r.result.transaction('dayHistory', 'readwrite');
          tx.objectStore('dayHistory').put({ id: 'unsaved:9', projectKey: 'unsaved', day: 9, savedAt: 'x', cash: 1, rating: 1, operatingProfit: 1, review: null, projectJson: '{ broken' });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.getByTestId('history-close').click();
  await page.getByTestId('open-history').click();
  // 一覧は再読み込みされる（閉じて開き直した）
  await expect(page.getByTestId('history-overlay').getByTestId('history-row-9')).toBeVisible();
  await page.getByTestId('history-overlay').getByTestId('history-restore-9').click();
  await expect(page.getByTestId('toast')).toContainText('戻せませんでした');
  await expect(page.getByTestId('company-day')).toHaveText('3日目');
  await page.getByTestId('history-overlay').getByTestId('history-delete-9').click();
  await expect(page.getByTestId('history-overlay').getByTestId('history-row-9')).toBeHidden();

  // 正常な履歴（2 日目の朝）に戻す
  await page.getByTestId('history-overlay').getByTestId('history-restore-1').click();
  await expect(page.getByTestId('company-day')).toHaveText('2日目');
  await expect(page.getByTestId('history-overlay')).toBeHidden();
  await expect(page.getByTestId('toast')).toContainText('2日目の朝に戻しました');
  await page.getByTestId('tab-finance').click();
  await expect(page.getByTestId('reports').locator('tbody tr')).toHaveCount(1);
});
