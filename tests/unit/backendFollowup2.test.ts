import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAttentionItems } from '../../src/core/attention';
import { HEAT_BAND_HIGH_MIN, HEAT_BAND_MID_MIN, heatBand } from '../../src/core/access/heatmap';
import { ROAD_LANE_CAPACITY_PER_HOUR } from '../../src/core/access/segments';
import { BALANCE } from '../../src/core/economy/balance';
import {
  CITY_EVENT_CONGESTED,
  CITY_NIGHT_CURFEW,
  CITY_PROFILE,
  NIGHT_OPS_DEFAULTS,
  NIGHT_OPS_RANGES,
  airMarketPopulationOf,
  cityEventEffects,
  cityEventOutcome,
  defaultCity,
  type CityEvent,
} from '../../src/core/economy/city';
import { createCompany } from '../../src/core/economy/company';
import { demandIndex, distanceFactor, essentialOf, monthOf, seasonalWeekdayFactor } from '../../src/core/economy/demand';
import { DIFFICULTY } from '../../src/core/economy/game';
import { DEFAULT_MAX_CONNECT_MIN } from '../../src/core/economy/hub';
import { destinationDef } from '../../src/core/economy/registry';
import { createHistory } from '../../src/core/editor/history';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { addTurnaround, createSimulation } from '../../src/core/sim/simulation';
import { createClock } from '../../src/core/sim/clock';
import { analyzeLayout } from '../../src/core/validation/validate';
import { editorStore } from '../../src/editor/store';
import { ACCESS_UI, DEMAND_UI, GAME_UI, HEAT_LEGEND, NIGHT_UI, OPS_NAV, SEASONALITY_PROFILE_LABEL } from '../../src/i18n/ja';
import { cityTypeLabel } from '../../src/ui/GameSetup';
import { RouteBasisDetail, routeDemandBasis } from '../../src/ui/ManagementPanels';
import { AlertStack } from '../../src/ui/operate/AlertStack';
import { FidsBoard } from '../../src/ui/operate/FidsBoard';
import { FidsOverlay } from '../../src/ui/operate/FidsOverlay';
import { OPS_BOARD_KEYS } from '../../src/ui/operate/DetailOverlay';
import { opsInboxAttention, partitionAlerts, type Alert } from '../../src/ui/operate/alerts';
import { opsUi } from '../../src/ui/operate/opsUi';
import { AirportSettings } from '../../src/ui/RunwayPanels';

/**
 * バックエンド追随 第3弾（項目2: 需要根拠・季節性の表示＋数値リテラル / 決定事項 FIDS-C・アラートC・空港設定B）。
 * 表示と文言の導出だけを固定する（sim の計算・判定は変えていないことの裏付けとして、
 * 表示値が core の正本関数・定数と一致することを確かめる）。
 */

const companyWithCity = () => {
  const c = createCompany('career', 'followup2');
  c.city = defaultCity('metropolitan');
  return c;
};

describe('項目2: 需要根拠（routeDemandBasis）', () => {
  it('国内目的地: 解決済み値が core の正本と一致する', () => {
    const c = companyWithCity();
    c.city = { ...c.city!, airMarketPopulation: 37_000_000 };
    const dest = destinationDef('TYO');
    const b = routeDemandBasis(c, 'TYO')!;
    expect(b).not.toBeNull();
    expect(b.catchment).toBe(dest.catchmentPopulation);
    expect(b.catchmentFallback).toBe(false);
    expect(b.aviationDependency).toBe(dest.aviationDependency);
    expect(b.essential).toBe(essentialOf(dest.demand));
    expect(b.leisure).toBe(dest.demand.leisure);
    expect(b.demandIndex).toBeCloseTo(demandIndex(dest), 10);
    expect(b.distanceKm).toBe(dest.distanceKm);
    expect(b.distanceFactor).toBeCloseTo(distanceFactor(dest.distanceKm), 12);
    expect(b.profile).toBe(dest.seasonalityProfile);
    expect(b.month).toBe(monthOf(c.day) + 1);
    // 季節・曜日の合成係数は既存 export の値そのもの（UI 側で月係数を複製しない）
    expect(b.todayFactor).toBeCloseTo(seasonalWeekdayFactor(dest, c.day), 12);
    expect(b.originMarket).toBe(airMarketPopulationOf(c.city!));
    expect(b.originFallback).toBe(false); // airMarketPopulation を明示設定したので設定値が使われる
    expect(b.k).toBe(BALANCE.market.K);
    expect(b.alpha).toBe(BALANCE.market.alpha);
    expect(b.beta).toBe(BALANCE.market.beta);
  });

  it('国際目的地: 圏域人口は人口へフォールバックし、プロファイルは無い', () => {
    const c = companyWithCity();
    const dest = destinationDef('SEL');
    expect(dest.catchmentPopulation).toBeNull();
    expect(dest.seasonalityProfile).toBeNull();
    const b = routeDemandBasis(c, 'SEL')!;
    expect(b.catchment).toBe(dest.population);
    expect(b.catchmentFallback).toBe(true);
    expect(b.aviationDependency).toBe(dest.aviationDependency); // 解決済みの既定値がそのまま出る
    expect(b.profile).toBeNull();
    expect(b.todayFactor).toBeCloseTo(seasonalWeekdayFactor(dest, c.day), 12);
  });

  it('出発側の航空市場人口が未設定の都市は人口フォールバックとして表示する', () => {
    const c = companyWithCity();
    c.city = { ...defaultCity('regional') };
    expect(airMarketPopulationOf(c.city)).toBe(c.city.population);
    const b = routeDemandBasis(c, 'TYO')!;
    expect(b.originMarket).toBe(c.city.population);
    expect(b.originFallback).toBe(true);
  });

  it('都市が無い会社・未知の行き先では根拠を出さない', () => {
    const bare = createCompany('career', 'followup2-bare');
    expect(bare.city).toBeFalsy();
    expect(routeDemandBasis(bare, 'TYO')).toBeNull();
    expect(routeDemandBasis(companyWithCity(), 'NOPE')).toBeNull();
  });

  it('展開行の描画に季節性ブロックと根拠の testid が含まれる', () => {
    const c = companyWithCity();
    const b = routeDemandBasis(c, 'TYO')!;
    const html = renderToString(createElement(RouteBasisDetail, { basis: b }));
    expect(html).toContain('data-testid="traffic-route-seasonality-TYO"');
    expect(html).toContain(SEASONALITY_PROFILE_LABEL.URBAN);
    expect(html).toContain(`K ${BALANCE.market.K.toLocaleString('ja-JP')}`);
    expect(DEMAND_UI.demandNote).toContain('暫定'); // K の暫定表記は路線表の注記側に置く
  });

  it('過大推計の注記は一般形（特定路線名を含まない）', () => {
    expect(DEMAND_UI.demandNote).not.toContain('仙台');
    expect(DEMAND_UI.demandNote).not.toContain('中部');
    expect(DEMAND_UI.demandNote).not.toContain('新千歳');
  });
});

describe('項目2: 数値リテラルの動的化（A 分類）', () => {
  it('L1 混雑凡例は core の帯境界（HEAT_BAND_*）から作られる', () => {
    expect(HEAT_BAND_MID_MIN).toBe(0.4);
    expect(HEAT_BAND_HIGH_MIN).toBe(0.7);
    expect(HEAT_LEGEND.low).toBe(`${Math.round(HEAT_BAND_MID_MIN * 100)}%未満`);
    expect(HEAT_LEGEND.mid).toBe(`${Math.round(HEAT_BAND_MID_MIN * 100)}%以上 ${Math.round(HEAT_BAND_HIGH_MIN * 100)}%未満`);
    expect(HEAT_LEGEND.high).toBe(`${Math.round(HEAT_BAND_HIGH_MIN * 100)}%以上`);
    expect(heatBand(HEAT_BAND_MID_MIN - 0.01)).toBe(0);
    expect(heatBand(HEAT_BAND_MID_MIN)).toBe(1);
    expect(heatBand(HEAT_BAND_HIGH_MIN - 0.01)).toBe(1);
    expect(heatBand(HEAT_BAND_HIGH_MIN)).toBe(2);
  });

  it('L2 難易度の説明は DIFFICULTY 定数から生成され、従来文言と一致する', () => {
    expect(GAME_UI.difficultyHint.normal).toBe('悪天 ×1.0 / 障害 ×0.6 / 資金 ×1.0 / 建設費 ×1.0 / 予報 90%');
    expect(GAME_UI.difficultyHint.hard).toBe('悪天 ×1.5 / 障害 ×1.0 / 資金 ×0.75 / 建設費 ×1.1 / 定時率 +5pt / 予報 80%');
    expect(GAME_UI.difficultyHint.expert).toBe('悪天 ×2.0 / 障害 ×1.5 / 資金 ×0.5 / 建設費 ×1.2 / 定時率 +10pt / 予報 65%');
    // 生成元は DIFFICULTY の各倍率（ハードコードされていないことの確認）
    expect(GAME_UI.difficultyHint.hard).toContain(`資金 ×${DIFFICULTY.hard.cashMul}`);
    expect(GAME_UI.difficultyHint.expert).toContain(`予報 ${Math.round(DIFFICULTY.expert.forecastAccuracy * 100)}%`);
  });

  it('L3 都市タイプの人口は CITY_PROFILE から読む', () => {
    expect(cityTypeLabel('regional')).toBe(`地方都市（人口 ${Math.round(CITY_PROFILE.regional.population / 10000)} 万）`);
    expect(cityTypeLabel('regional')).toBe('地方都市（人口 60 万）');
    expect(cityTypeLabel('core')).toBe('中核都市（人口 400 万）');
    expect(cityTypeLabel('metropolitan')).toBe('大都市（人口 2,000 万）');
  });

  it('L4 イベント混雑時の倍率は CITY_EVENT_CONGESTED と一致する', () => {
    const findEvent = (outcome: 'smooth' | 'congested'): CityEvent => {
      for (let i = 0; i < 500; i++) {
        const e: CityEvent = { id: `followup2-${outcome}-${i}`, day: 0, durationDays: 2, kind: 'festival', scale: 3, location: 'cityCenter', wagered: true };
        if (cityEventOutcome(e) === outcome) return e;
      }
      throw new Error('not found');
    };
    const base = defaultCity('regional');
    const smooth = cityEventEffects({ ...base, events: [findEvent('smooth')] }, 0);
    const congested = cityEventEffects({ ...base, events: [findEvent('congested')] }, 0);
    // 需要の伸び分は demandGrowthMul の割合に、交通の増分は trafficMul 倍になる
    expect((congested.demandMultiplier - 1) / (smooth.demandMultiplier - 1)).toBeCloseTo(CITY_EVENT_CONGESTED.demandGrowthMul, 10);
    expect((congested.trafficMultiplier - 1) / (smooth.trafficMultiplier - 1)).toBeCloseTo(CITY_EVENT_CONGESTED.trafficMul, 10);
  });

  it('L5 アクセス集計モデルの 900 は BALANCE.accessModel.roadPerEntrance と一致する', () => {
    expect(ROAD_LANE_CAPACITY_PER_HOUR).toBe(900);
    expect(ACCESS_UI.modelAggregate).toContain(String(BALANCE.accessModel.roadPerEntrance));
  });

  it('L6 夜間帯・締切の文言は city.ts の定数から作られる', () => {
    const hh = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    expect(NIGHT_UI.note).toContain(`${hh(CITY_NIGHT_CURFEW.fromMin)}〜${hh(CITY_NIGHT_CURFEW.toMin)}`);
    expect(NIGHT_UI.note).toContain('22:00〜06:00');
    const lead = `${CITY_NIGHT_CURFEW.fromMin - NIGHT_OPS_RANGES.departureCutoffMin.min}〜${CITY_NIGHT_CURFEW.fromMin - NIGHT_OPS_RANGES.departureCutoffMin.max}`;
    expect(lead).toBe('120〜15');
    expect(NIGHT_UI.cutoffHelp).toContain(lead);
    expect(NIGHT_UI.cutoffHelp).toContain(hh(NIGHT_OPS_DEFAULTS.departureCutoffMin));
  });

  it('L7 乗継の上限（分）は DEFAULT_MAX_CONNECT_MIN を正本とする', () => {
    expect(DEFAULT_MAX_CONNECT_MIN).toBe(240);
  });
});

describe('決定C: ライブアラートの出し分け', () => {
  const alert = (over: Partial<Alert>): Alert => ({
    key: 'a',
    severity: 'warning',
    t: 0,
    title: 't',
    count: 1,
    target: { kind: 'none', id: null },
    actions: [],
    ...over,
  });

  it('重大はスタックへ、注意はインボックスへ（重複なし・順序維持）', () => {
    const alerts = [
      alert({ key: 'w1', severity: 'warning' }),
      alert({ key: 'c1', severity: 'critical' }),
      alert({ key: 'w2', severity: 'warning' }),
      alert({ key: 'c2', severity: 'critical' }),
    ];
    const { stack, inbox } = partitionAlerts(alerts);
    expect(stack.map((a) => a.key)).toEqual(['c1', 'c2']);
    expect(inbox.map((a) => a.key)).toEqual(['w1', 'w2']);
  });

  it('インボックス項目: 対象はエリア・滑走路・スポットだけを残し、件数を count に載せる', () => {
    const layout = createSampleAirport();
    const areaId = Object.keys(layout.terminalAreas)[0]!;
    const items = opsInboxAttention([
      alert({ key: 'equipment:belt:x', severity: 'warning', title: '設備停止', count: 3, target: { kind: 'area', id: areaId } }),
      alert({ key: 'flow:departure', severity: 'warning', title: '出発の流れ', target: { kind: 'aircraft', id: 'ac1' } }),
      alert({ key: 'crit', severity: 'critical', title: '重大はインボックスに出さない' }),
    ]);
    expect(items.map((i) => i.key)).toEqual(['equipment:belt:x', 'flow:departure']);
    expect(items[0]!.count).toBe(3);
    expect(items[0]!.targetId).toBe(areaId);
    expect(items[1]!.targetId).toBeNull();
  });

  it('buildAttentionItems: ops 由来は mid 帯で、日報が無くても出る。未指定なら従来どおり出ない', () => {
    const layout = createSampleAirport();
    const company = createCompany('career', 'followup2-attn');
    const analysis = analyzeLayout(layout);
    const base = buildAttentionItems({ layout, analysis, company });
    expect(base.filter((i) => i.source === 'ops')).toEqual([]);
    const withOps = buildAttentionItems({
      layout,
      analysis,
      company,
      opsAlerts: [{ key: 'equipment:belt:x', title: '設備停止: 仕分機', count: 2, targetId: 'not-an-entity' }],
    });
    const opsItems = withOps.filter((i) => i.source === 'ops');
    expect(opsItems).toHaveLength(1);
    expect(opsItems[0]!.band).toBe('mid');
    expect(opsItems[0]!.id).toBe('ops:equipment:belt:x');
    expect(opsItems[0]!.metric).toBe(2);
    expect(opsItems[0]!.targetId).toBeUndefined(); // 実体でない対象は落とす
  });
});

describe('決定C/FIDS-C: 実際の運航状態での描画', () => {
  const t0 = 6 * 3600;

  const setupSim = () => {
    const layout = createSampleAirport();
    const sim = createSimulation(layout, { seed: 'followup2', settings: { autoSchedule: false } });
    const standId = Object.values(layout.facilities).find((f) => f.kind === 'gate')!.props.standId as string;
    addTurnaround(sim, 'narrow180', t0 + 20 * 60, {
      departureAt: t0 + 220 * 60,
      plan: { contractId: 'test', destinationId: 'KTA', arrPax: 10, depPax: 10, standId, seats: 180 },
    });
    editorStore.setState({ ops: { sim, clock: createClock(60), selectedAircraft: null, frame: 0, uiVersion: 1, dropped: false } });
    return { layout, sim };
  };

  afterEach(() => {
    editorStore.setState({ ops: null });
    opsUi.reset();
  });

  it('FIDS-C: 浮動パネルは要約のみ＋ボードへの導線、全列は運航ボード側', () => {
    setupSim();
    const floating = renderToString(createElement(FidsOverlay));
    expect(floating).toContain('data-testid="fids-open-board"');
    expect(floating).not.toContain('遅延理由'); // 全列の見出しは浮動側に無い
    expect(floating).not.toContain('data-testid="flight-full-');
    const board = renderToString(createElement(FidsBoard));
    expect(board).toContain('data-testid="fids-board"');
    expect(board).toContain('遅延理由');
    expect(board).toContain('data-testid="pax-');
    expect(board).toContain('data-testid="flight-full-');
  });

  it('FIDS-C: 運航ボードのキーに flights が入り、ラベルを持つ', () => {
    expect(OPS_BOARD_KEYS).toContain('flights');
    const navLabel = OPS_NAV.find(([k]) => k === 'flights')?.[1];
    expect(navLabel).toBeTruthy();
    expect(navLabel).not.toBe('flights');
    opsUi.openOverlay('flights');
    expect(opsUi.get().overlay).toBe('flights');
    opsUi.toggleOverlay('flights');
    expect(opsUi.get().overlay).toBeNull();
  });

  it('アラートC: スタックには重大（滑走路閉鎖）だけが出て、注意（設備停止）は出ない', () => {
    const { layout, sim } = setupSim();
    const runwayId = Object.keys(layout.runways)[0]!;
    const facilityId = Object.keys(layout.facilities)[0]!;
    sim.state.disruptions.push({
      id: 'd-followup2',
      kind: 'runwayClosed',
      origin: 'manual',
      targetId: runwayId,
      start: 0,
      end: null,
      status: 'active',
      resolvedAt: null,
      resolvedBy: null,
      affected: { tasks: [], flights: [], units: [] },
    });
    sim.state.equipment[`belt:${facilityId}`] = { broken: true, repairUntil: null, downSec: 0 };
    const html = renderToString(createElement(AlertStack));
    expect(html).toContain(`data-testid="alert-disruption:runwayClosed:${runwayId}"`);
    expect(html).not.toContain('data-testid="alert-equipment:');
    expect(html).toContain('data-testid="alert-inbox-note"'); // 注意はインボックスへ誘導
  });
});

describe('決定B: 空港設定の分割', () => {
  it('インスペクタには頻出項目と開くボタンだけが残り、低頻度項目はモーダル側（初期描画に出ない）', () => {
    editorStore.setState({ history: createHistory(createSampleAirport()), mode: 'build' });
    const html = renderToString(createElement(AirportSettings));
    expect(html).toContain('data-testid="airport-settings"');
    expect(html).toContain('data-testid="airport-settings-open"');
    expect(html).toContain('data-testid="setting-taxiMode"');
    expect(html).toContain('data-testid="setting-taxiBlockTiles"');
    expect(html).toContain('data-testid="settings-designators"');
    // 低頻度項目（磁偏角・ルールセット・アクセスモデル）はモーダルを開くまで描画されない
    expect(html).not.toContain('data-testid="setting-magvar"');
    expect(html).not.toContain('data-testid="setting-ruleSet"');
    expect(html).not.toContain('data-testid="setting-accessModel"');
    editorStore.setState({ ops: null });
  });
});
