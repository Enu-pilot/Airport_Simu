import type { Locator, Page } from '@playwright/test';

/**
 * UI 再編（建設パネルのタブ化・ツールの折りたたみカテゴリ化）後の操作手順をまとめた E2E 用ヘルパー。
 * 利用者と同じ操作（タブを押す・カテゴリ見出しを開く）で対象を表示してから返す。期待値は変えない。
 */

type BuildPanel = 'tools' | 'facilities' | 'inbox';

/** 建設パネルのタブ（ツール／施設一覧／要対応）を開く。運航中や別画面でタブが無いときは何もしない */
export async function openBuildPanel(page: Page, panel: BuildPanel): Promise<void> {
  const tab = page.getByTestId(`build-panel-${panel}`);
  if (!(await tab.isVisible().catch(() => false))) return;
  if ((await tab.getAttribute('aria-pressed')) !== 'true') await tab.click();
}

/** ツールボタン（`tool-<id>`）。ツールタブを開き、折りたたまれたカテゴリなら見出しを開いてから返す */
export async function tool(page: Page, id: string): Promise<Locator> {
  await openBuildPanel(page, 'tools');
  const button = page.getByTestId(`tool-${id}`);
  if (!(await button.isVisible().catch(() => false))) {
    const summary = button.locator('xpath=ancestor::details[1]/summary');
    if (await summary.count()) await summary.click();
  }
  return button;
}

/** 施設一覧の見出し（FacilityList の groups と同じ分類）。ID の接頭辞・種別から決める */
const ROW_GROUP: Record<string, string> = {
  rwy: '滑走路',
  twy: '誘導路',
  tn: '交差点・滑走路入口',
  std: '駐機スポット',
  rd: '道路',
};

/** 施設一覧の行（`row-<id>`）。施設一覧タブを開き、折りたたまれた分類なら見出しを開いてから返す */
export async function row(page: Page, id: string): Promise<Locator> {
  await openBuildPanel(page, 'facilities');
  const r = page.getByTestId(`row-${id}`);
  if (!(await r.isVisible().catch(() => false))) {
    const title = ROW_GROUP[id.slice(0, id.indexOf('_'))];
    if (title) {
      const header = page.getByTestId('facility-list').locator('.list-group-title', { hasText: title }).first();
      if (await header.count()) await header.click();
    }
  }
  return r;
}

/** 要対応タブ（配置・接続チェック。`issues`・`count-*` を含む）を開く */
export async function inbox(page: Page): Promise<void> {
  await openBuildPanel(page, 'inbox');
}

/** 要対応タブ内の要素（`issues`・`count-error` など）。要対応タブを開いてから返す */
export async function inboxEl(page: Page, testId: string): Promise<Locator> {
  await inbox(page);
  return page.getByTestId(testId);
}

/** 空港の詳細設定（磁気偏角・判定ルール等）のダイアログを開く。すでに開いていれば何もしない */
export async function openAirportSettings(page: Page): Promise<void> {
  if (await page.getByTestId('airport-settings-modal').isVisible().catch(() => false)) return;
  await page.getByTestId('airport-settings-open').click();
}

/** 空港の詳細設定のダイアログを閉じる。開いていなければ何もしない */
export async function closeAirportSettings(page: Page): Promise<void> {
  if (await page.getByTestId('airport-settings-modal').isVisible().catch(() => false)) await page.getByTestId('airport-settings-close').click();
}

/**
 * プロジェクト（保存・読み込み）の画面を開く。運航中は運航ナビのボード、建設中は経営画面の「プロジェクト・保存」。
 * 建設画面の下部タブは表示高が小さく、保存済み一覧の行が固定見出しの下に隠れて押せないため（docs/implementation/active/ui_usability_improvement_plan.md U1）、
 * 同じ ProjectPanel を全画面で表示する経営画面を使う。
 */
export async function openProjectPanel(page: Page): Promise<void> {
  if (await page.getByTestId('ops-nav').isVisible().catch(() => false)) {
    await page.getByTestId('tab-project').click();
    return;
  }
  if (!(await page.getByTestId('management-project').isVisible().catch(() => false))) await page.getByTestId('page-management').click();
  await page.getByTestId('management-project').click();
}

/** 表示レイヤのチェック（`overlay-<key>`）。レールの「レイヤー」ポップオーバーを開いてから返す */
export async function overlayToggle(page: Page, key: string): Promise<Locator> {
  const pop = page.getByTestId('overlays-pop');
  if (!(await pop.evaluate((node) => (node as HTMLDetailsElement).open))) await pop.locator('summary').click();
  return page.getByTestId(`overlay-${key}`);
}
