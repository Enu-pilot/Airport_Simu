import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { addContract, contractsOf, createCareerCompany, type CompanyState } from '../../src/core/economy/company';
import { editorStore } from '../../src/editor/store';
import { ContractsPanel, ContractsTabBar, contractsTabSummary, type ContractsTabSummary } from '../../src/ui/ManagementPanels';

/**
 * 契約パネルのレイアウト改善 案A（ui-contracts-layout.md）:
 * パネル内サブタブ「契約中（N）」「提案（N）」「終了分（N）」＋件数バッジ＋提案の最短期限表示。
 * - バッジ件数は検索フィルタに依存せず、会社の契約データそのものと一致する
 * - 既定タブは「契約中」（従来の表示・既存テストの前提を維持）し、提案への気づきはバッジと最短期限で担保する
 * - 終了分のバッジは全件数、パネル内の表示は従来どおり直近8件（注記つき）
 *
 * 描画は renderToString（serviceModesUi.test.ts と同じ流儀）。zustand の SSR スナップショットは
 * ストアの初期状態を返すため、パネル全体の描画確認は初期状態（サンドボックス会社）で行い、
 * 件数・期限の描画そのものは ContractsTabBar（props 駆動）で検証する。
 */

const base = { feeDiscount: 0.1, startDay: 0, endDay: 30, window: 'any' as const, perDay: 1, typeId: 'B737-800' as const };

function companyWithTabs(): CompanyState {
  const c = createCareerCompany('tabs'); // 契約中 2件（RJ/KTA・HB/MSK）
  addContract(c, { ...base, airlineId: 'RJ', destinationId: 'KTA', status: 'offered', offerExpiresDay: 9 });
  addContract(c, { ...base, airlineId: 'HB', destinationId: 'MSK', status: 'offered', offerExpiresDay: 4 });
  addContract(c, { ...base, airlineId: 'RJ', destinationId: 'KTA', status: 'ended', offerExpiresDay: 0 });
  return c;
}

describe('contractsTabSummary（バッジ件数の集計）', () => {
  it('契約中・提案・終了分の件数が契約データと一致する', () => {
    const c = companyWithTabs();
    const s = contractsTabSummary(c);
    expect(s.active).toBe(contractsOf(c, 'active').length);
    expect(s.offers).toBe(contractsOf(c, 'offered').length);
    expect(s.past).toBe(contractsOf(c).filter((k) => k.status !== 'active' && k.status !== 'offered').length);
    expect([s.active, s.offers, s.past]).toEqual([2, 2, 1]);
  });

  it('提案の最短期限は offerExpiresDay の最小値、提案が無ければ null', () => {
    expect(contractsTabSummary(companyWithTabs()).nearestOfferExpiresDay).toBe(4);
    const s = contractsTabSummary(createCareerCompany('tabs-no-offers'));
    expect(s.offers).toBe(0);
    expect(s.nearestOfferExpiresDay).toBeNull();
  });

  it('終了分は表示上限（直近8件）を超えても全件数を返す', () => {
    const c = createCareerCompany('tabs-many-past');
    for (let i = 0; i < 10; i++) {
      addContract(c, { ...base, airlineId: 'RJ', destinationId: 'KTA', status: 'expired', offerExpiresDay: 0 });
    }
    expect(contractsTabSummary(c).past).toBe(10);
  });
});

describe('ContractsTabBar（バッジと最短期限の描画）', () => {
  const summary: ContractsTabSummary = { active: 12, offers: 3, past: 10, nearestOfferExpiresDay: 4 };

  it('3タブに件数バッジが出て、選択中タブが active になる', () => {
    const html = renderToString(createElement(ContractsTabBar, { tab: 'active', onTab: () => {}, summary }));
    expect(html).toContain('data-testid="contracts-badge-active">12<');
    expect(html).toContain('data-testid="contracts-badge-offers">3<');
    expect(html).toContain('data-testid="contracts-badge-past">10<');
    expect(html).toMatch(/class="tab active" data-testid="contracts-tab-active"/);
    expect(html).toMatch(/aria-selected="true" class="tab active" data-testid="contracts-tab-active"|class="tab active" data-testid="contracts-tab-active"/);
  });

  it('提案タブを開いていなくても最短期限が見える（気づきの導線）', () => {
    const html = renderToString(createElement(ContractsTabBar, { tab: 'active', onTab: () => {}, summary }));
    expect(html).toContain('data-testid="contracts-offers-deadline"');
    // SSR はテキストノード間に <!-- --> を挟むため除去してから見る
    expect(html.replace(/<!-- -->/g, '')).toContain('最短5日目まで'); // offerExpiresDay 4 → 5日目まで
  });

  it('提案が無ければ最短期限は出ない', () => {
    const html = renderToString(
      createElement(ContractsTabBar, { tab: 'offers', onTab: () => {}, summary: { active: 0, offers: 0, past: 0, nearestOfferExpiresDay: null } }),
    );
    expect(html).toContain('data-testid="contracts-badge-offers">0<');
    expect(html).not.toContain('contracts-offers-deadline');
  });
});

describe('ContractsPanel のサブタブ（初期状態での描画）', () => {
  it('既定タブは契約中で、バッジは初期状態の会社の集計と一致する', () => {
    const initial = contractsTabSummary(editorStore.getInitialState().company);
    const html = renderToString(createElement(ContractsPanel, {}));
    expect(html).toContain('data-testid="contracts-panel"');
    expect(html).toContain(`data-testid="contracts-badge-active">${initial.active}<`);
    expect(html).toContain(`data-testid="contracts-badge-offers">${initial.offers}<`);
    expect(html).toContain(`data-testid="contracts-badge-past">${initial.past}<`);
    // 既定は契約中タブ: 契約中テーブルがあり、提案テーブルは無い（既存 testid の前提を維持）
    expect(html).toContain('data-testid="contracts"');
    expect(html).not.toContain('data-testid="offers"');
  });

  it('提案タブ（initialTab）では提案テーブルが出て、契約中テーブルは出ない', () => {
    const html = renderToString(createElement(ContractsPanel, { initialTab: 'offers' }));
    expect(html).toContain('data-testid="offers"');
    expect(html).not.toContain('data-testid="contracts"');
  });

  it('終了分タブ（initialTab）では終了分の見出しが出て、契約中テーブルは出ない', () => {
    const html = renderToString(createElement(ContractsPanel, { initialTab: 'past' }));
    expect(html).toContain('終了した契約・提案');
    expect(html).not.toContain('data-testid="contracts"');
    expect(html).not.toContain('data-testid="offers"');
  });
});
