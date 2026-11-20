import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { editorStore, setServiceGranularity } from '../../src/editor/store';
import type { ServiceCategoryUsage } from '../../src/core/sim/serviceAggregate';
import { runServiceDetailSim } from '../../src/core/terminal/serviceDetailSim';
import {
  ServiceDetailResultView,
  ServiceDetailSection,
  ServiceGranularitySelect,
  ServiceProfileSection,
} from '../../src/ui/ServiceModesPanel';
import { layoutWithShops } from './serviceFixture';
import { placeTerminalArea } from '../../src/core/layout/operations';
import { must } from './helpers';

/**
 * 5-19 T11–T13 の UI 接続（引き渡しメモ Step 5）のテスト。
 * 粒度設定の保持、集約 profile の表示（ラウンジが通常行として実値を出すことを含む）、
 * 集約実績の表示、詳細シミュレーション結果の店舗別/集約表示を固定する。
 * 描画は renderToString（numberInput.test.ts と同じ流儀）で、実データの整合は core の結果で担保する。
 * 既定の粒度は 1B（集約既定化）に追随して 'aggregate'。
 */

describe('店舗シミュレーション粒度の設定', () => {
  it('既定は aggregate（1B の集約既定）で、切替が store に反映される', () => {
    expect(editorStore.getState().serviceGranularity).toBe('aggregate');
    setServiceGranularity('detailed');
    expect(editorStore.getState().serviceGranularity).toBe('detailed');
    setServiceGranularity('aggregate');
    expect(editorStore.getState().serviceGranularity).toBe('aggregate');
  });

  it('設定セレクトに詳細/集約の両選択肢が出る', () => {
    const html = renderToString(createElement(ServiceGranularitySelect));
    expect(html).toContain('data-testid="setting-service-granularity"');
    expect(html).toContain('詳細（店舗ごと）');
    expect(html).toContain('集約（カテゴリ×ターミナル）');
  });
});

describe('集約 profile の表示', () => {
  it('カテゴリ×ターミナルの能力が出て、ラウンジも通常行（未設置）で出る', () => {
    const { layout, terminal } = layoutWithShops();
    const html = renderToString(
      createElement(ServiceProfileSection, { layout, liveGranularity: null, liveUsage: null }),
    );
    expect(html).toContain('data-testid="service-profile"');
    expect(html).toContain(`data-testid="service-profile-${terminal}-retail"`);
    expect(html).toContain(`data-testid="service-profile-${terminal}-dining"`);
    expect(html).toContain(`data-testid="service-profile-${terminal}-waiting"`);
    // 2A でラウンジは実種別になったため、特例行（未対応）は出さず通常行の状態表示になる
    expect(html).not.toContain('未対応');
    const loungeRow = html.slice(html.indexOf(`service-profile-${terminal}-lounge`));
    expect(loungeRow.slice(0, loungeRow.indexOf('</tr>'))).toContain('未設置');
    // 運航していないときは実績なしの注記
    expect(html).toContain('data-testid="service-usage-none"');
  });

  it('ラウンジを置いたターミナルでは、ラウンジ行が席数の実値を出す', () => {
    const base = layoutWithShops();
    const placed = must(placeTerminalArea(base.layout, base.terminal, 1, 'lounge', { x: 96, y: 51 }, { w: 4, h: 2, name: 'ラウンジ', props: { seats: 40 } }));
    const html = renderToString(
      createElement(ServiceProfileSection, { layout: placed.layout, liveGranularity: null, liveUsage: null }),
    );
    const loungeRow = html.slice(html.indexOf(`service-profile-${base.terminal}-lounge`));
    const row = loungeRow.slice(0, loungeRow.indexOf('</tr>'));
    expect(row).toContain('利用可能');
    expect(row).toContain('40');
    expect(row).not.toContain('未対応');
  });

  it('集約方式で運航中の実績がカテゴリ単位で出る', () => {
    const { layout, terminal } = layoutWithShops();
    const usage = new Map<string, ServiceCategoryUsage>([
      [`${terminal}|retail`, { users: 12, groups: 5, dwellPaxSec: 12 * 480, revenue: 180, skipped: 3 }],
    ]);
    const html = renderToString(
      createElement(ServiceProfileSection, { layout, liveGranularity: 'aggregate', liveUsage: usage }),
    ).replaceAll('<!-- -->', '');
    expect(html).toContain('data-testid="service-usage"');
    expect(html).toContain(`data-testid="service-usage-${terminal}-retail"`);
    expect(html).toContain('12 人');
    expect(html).toContain('180 cr');
  });

  it('詳細方式で運航中は、集約実績が記録されない旨が出る（数値を捏造しない）', () => {
    const { layout } = layoutWithShops();
    const html = renderToString(
      createElement(ServiceProfileSection, { layout, liveGranularity: 'detailed', liveUsage: null }),
    );
    expect(html).toContain('data-testid="service-usage-detailed"');
    expect(html).not.toContain('data-testid="service-usage"');
  });
});

describe('ターミナル詳細シミュレーションの表示', () => {
  it('実行フォーム（対象・時間・需要・seed）が出る', () => {
    const { layout } = layoutWithShops();
    const html = renderToString(createElement(ServiceDetailSection, { layout }));
    expect(html).toContain('data-testid="service-detail"');
    expect(html).toContain('data-testid="service-detail-terminal"');
    expect(html).toContain('data-testid="service-detail-duration"');
    expect(html).toContain('data-testid="service-detail-groups"');
    expect(html).toContain('data-testid="service-detail-seed"');
    expect(html).toContain('data-testid="service-detail-run"');
    expect(html).not.toContain('data-testid="service-detail-result"');
  });

  it('結果表示: 店舗別実績と同一指標のカテゴリ集約が並ぶ', () => {
    const { layout, terminal, shop, restaurant, waiting } = layoutWithShops();
    const result = runServiceDetailSim(layout, {
      terminalId: terminal, seed: 'ui-test', durationSec: 3 * 3600, groupsPerHour: 60, visitProb: 1,
    });
    const html = renderToString(createElement(ServiceDetailResultView, { layout, result }));
    expect(html).toContain('data-testid="service-detail-result"');
    // 店舗別: どちらかの店舗と待合の行が出る
    expect(html.includes(`service-detail-store-${shop}`) || html.includes(`service-detail-store-${restaurant}`)).toBe(true);
    expect(html).toContain(`data-testid="service-detail-store-${waiting}"`);
    // 集約: 対象ターミナルと空港全体の行が同じ指標で出る
    expect(html).toContain('data-testid="service-detail-aggregated"');
    expect(html).toContain('data-testid="service-detail-agg-airport-retail"');
    expect(html).toContain('data-testid="service-detail-agg-terminal-waiting"');
    // 店舗別合計 = カテゴリ集約（空港全体）の合計であることが、表示の前提として保たれる
    const storeUsers = Object.values(result.records).reduce((s, r) => s + r.users, 0);
    const aggUsers = result.aggregated.airport.reduce((s, r) => s + r.users, 0);
    expect(aggUsers).toBe(storeUsers);
    // このフィクスチャにはラウンジが無いので、集約でもラウンジの利用者は 0 のまま
    expect(result.aggregated.airport.find((r) => r.category === 'lounge')?.users).toBe(0);
  });
});
