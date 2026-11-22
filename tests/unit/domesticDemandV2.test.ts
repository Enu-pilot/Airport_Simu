import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../src/core/economy/balance';
import { defaultCity, isCityConfig, type CityConfig } from '../../src/core/economy/city';
import { createCompany, type CompanyState } from '../../src/core/economy/company';
import {
  demandIndex, demandModelVersionOf, distanceFactorV2, effectiveMarketMass, marketNodeOf,
  odAviationDependency, odDistanceKm, routeDemand,
} from '../../src/core/economy/demand';
import { destinationDef } from '../../src/core/economy/registry';

/**
 * 国内線需要モデル v2（対称重力モデル化・案 B）の受入と校正を固定する。
 * 設計・校正の正本は docs/implementation/active/domestic_route_demand_realism_plan.md §11。
 *
 * 校正データ: 国土交通省「航空輸送統計年報」2025 年度の路線別旅客数（両方向）を
 * fit に、2024 年暦年（e-Stat）を年度 holdout に使う。実績は供給の結果としての
 * 実現旅客数であり潜在需要そのものではないため、全路線 ±5% の一致は目標にしない
 * （docs/46 受入条件 11 と同じ）。物差しは中央対数誤差・0.7〜1.3 帯域の収納率・
 * 順位相関・出発市場ごとの合計比で、現行 v1（羽田 12 路線で中央対数誤差 0.180、
 * 帯域 8/12、Spearman 0.944）を上回ることを受入条件とする。
 */

// [出発ノード, 目的地, 実績/日（両方向）] 2025 年度（fit）
const FIT: [string, string, number][] = [
  ['TYO', 'SPK', 28250], ['TYO', 'FUK', 26152], ['TYO', 'OKA', 19235], ['TYO', 'OSA', 14559],
  ['TYO', 'KOJ', 7006], ['TYO', 'KMJ', 5762], ['TYO', 'NGS', 5197], ['TYO', 'HIJ', 5175],
  ['TYO', 'MYJ', 4571], ['TYO', 'KMI', 4177], ['TYO', 'HKD', 3535], ['TYO', 'AKJ', 2723],
  ['NGO', 'OKA', 4010], ['NGO', 'SPK', 3909],
  ['FUK', 'OKA', 6347], ['FUK', 'SPK', 2651],
  ['OKA', 'ISG', 2820],
  ['OSA', 'SPK', 7476], // 大阪市場 = 伊丹 3,903 + 関西 3,573（ノードは都市市場単位）
];
// 2024 年暦年（年度 holdout。日平均は 366 日換算）
const HOLDOUT: [string, string, number][] = [
  ['TYO', 'SPK', 25991], ['TYO', 'FUK', 24352], ['TYO', 'OKA', 18131], ['TYO', 'OSA', 13451],
  ['TYO', 'KOJ', 6732], ['SDJ', 'SPK', 2396], ['NGO', 'SPK', 3726],
];

/** ノード付き会社（評価 50・料金倍率 1.0 相当。routeDemand は access=1 で呼ぶ） */
function nodeCompany(nodeId: string): CompanyState {
  const c = createCompany('career', `v2-${nodeId}`);
  // airMarketPopulation は v1（国際線・フォールバック時）の出発側質量として揃えておく
  c.city = { ...defaultCity('metropolitan'), airMarketPopulation: 37_000_000, marketNodeId: nodeId };
  c.rating = 50;
  return c;
}
function demandFrom(nodeId: string, destId: string): number {
  return routeDemand(nodeCompany(nodeId), destinationDef(destId), 1)!;
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
function spearman(xs: number[], ys: number[]): number {
  const rank = (vs: number[]) => {
    const idx = vs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(vs.length);
    idx.forEach(([, i], k) => { r[i] = k; });
    return r;
  };
  const rx = rank(xs), ry = rank(ys); const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i]! - mx) * (ry[i]! - my); dx += (rx[i]! - mx) ** 2; dy += (ry[i]! - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}

describe('v2 モデル選択とフォールバック', () => {
  it('marketNodeId がなければ v1（国内・国際とも従来値）', () => {
    const c = createCompany('career', 'v2-fallback');
    c.city = { ...defaultCity('metropolitan'), airMarketPopulation: 37_000_000 };
    c.rating = 50;
    expect(demandModelVersionOf(c, destinationDef('SPK'))).toBe(1);
    // v1 の式どおり: K=711 の羽田再現ケース（計画書 §3.2 の分析値）
    expect(routeDemand(c, destinationDef('SPK'), 1)!).toBeCloseTo(15839, -2);
  });

  it('marketNodeId があっても国際線は v1 のまま（国際線の需要は不変）', () => {
    const withNode = nodeCompany('TYO');
    const without = createCompany('career', 'v2-intl-base');
    without.city = { ...defaultCity('metropolitan'), airMarketPopulation: 37_000_000 };
    without.rating = 50;
    withNode.rating = 50;
    expect(demandModelVersionOf(withNode, destinationDef('SEL'))).toBe(1);
    expect(routeDemand(withNode, destinationDef('SEL'), 1)).toBe(routeDemand(without, destinationDef('SEL'), 1));
  });

  it('解決できない marketNodeId は v1 にフォールバックする', () => {
    const c = createCompany('career', 'v2-unknown-node');
    c.city = { ...defaultCity('metropolitan'), marketNodeId: 'ZZZ' };
    c.rating = 50;
    expect(marketNodeOf(c.city)).toBeNull();
    expect(demandModelVersionOf(c, destinationDef('SPK'))).toBe(1);
  });

  it('marketNodeId の形が不正な都市設定は検証で落ちる（旧セーブの city ごと削除を招かない範囲）', () => {
    const base: CityConfig = { ...defaultCity('metropolitan') };
    expect(isCityConfig(base)).toBe(true);
    expect(isCityConfig({ ...base, marketNodeId: 'TYO' })).toBe(true);
    expect(isCityConfig({ ...base, marketNodeId: 'tokyo' })).toBe(false);
    expect(isCityConfig({ ...base, marketNodeId: 42 })).toBe(false);
  });

  it('架空都市もノードになれる（KTA を市場として使う）', () => {
    const c = nodeCompany('KTA');
    expect(demandModelVersionOf(c, destinationDef('SPK'))).toBe(2);
    expect(routeDemand(c, destinationDef('SPK'), 1)!).toBeGreaterThan(0);
  });
});

describe('v2 の部品', () => {
  it('OD 距離は座標から算出する（福岡―那覇は固定値 1,550km ではなく約 860km）', () => {
    const d = odDistanceKm(destinationDef('FUK'), destinationDef('OKA'));
    expect(d).toBeGreaterThan(830);
    expect(d).toBeLessThan(900);
    expect(odDistanceKm(destinationDef('TYO'), destinationDef('SPK'))).toBeGreaterThan(800);
    expect(odDistanceKm(destinationDef('TYO'), destinationDef('SPK'))).toBeLessThan(850);
  });

  it('実効市場質量は利用圏人口 + visitorMass（那覇は 147 万 + 12 万）', () => {
    expect(effectiveMarketMass(destinationDef('OKA'))).toBe(1_470_000 + 120_000);
    expect(effectiveMarketMass(destinationDef('ISG'))).toBe(55_000 + 13_000);
    expect(effectiveMarketMass(destinationDef('SPK'))).toBe(5_043_000);
  });

  it('A_od: 明示値は方向に依存せず、既定値は目的地の事前値、範囲は 0.5〜2.0', () => {
    const tyo = destinationDef('TYO'), spk = destinationDef('SPK'), hij = destinationDef('HIJ');
    expect(odAviationDependency(tyo, spk)).toBe(1.94);
    expect(odAviationDependency(spk, tyo)).toBe(1.94); // 明示値は unordered ペアで引く
    expect(odAviationDependency(tyo, hij)).toBeCloseTo(0.64, 10); // 既定 = 目的地の事前値
    for (const o of ['TYO', 'NGO', 'FUK', 'OKA', 'SDJ']) {
      for (const d of ['SPK', 'OSA', 'KOJ', 'ISG', 'HKD']) {
        const v = odAviationDependency(destinationDef(o), destinationDef(d));
        expect(v, `${o}-${d}`).toBeGreaterThanOrEqual(0.5);
        expect(v, `${o}-${d}`).toBeLessThanOrEqual(2.0);
      }
    }
  });

  it('g2(d): 0km で 0、単調に立ち上がり、長距離で緩やかに減衰する', () => {
    expect(distanceFactorV2(0)).toBe(0);
    expect(distanceFactorV2(300)).toBeGreaterThan(0.5);
    expect(distanceFactorV2(300)).toBeLessThan(distanceFactorV2(600));
    expect(distanceFactorV2(900)).toBeCloseTo(1, 1);
    expect(distanceFactorV2(3000)).toBeLessThan(distanceFactorV2(1500));
    expect(distanceFactorV2(3000)).toBeGreaterThan(0.5);
  });

  it('対称な部分と片側の部分: 明示 OD では D(A,B)/D(B,A) が需要指数の比に一致する', () => {
    // 質量・距離・A_od（明示値）は方向で共通。差は目的地側の需要指数 I_d だけ（docs/46 §3.2 の設計）
    const ab = demandFrom('TYO', 'SPK');
    const ba = demandFrom('SPK', 'TYO');
    expect(ab / ba).toBeCloseTo(demandIndex(destinationDef('SPK')) / demandIndex(destinationDef('TYO')), 6);
  });
});

describe('v2 校正（2025 年度 fit / 2024 年 holdout）', () => {
  it('KDomestic は校正値 615（逆算 K の中央値 615.4 を丸めた）', () => {
    expect(BALANCE.market.domesticV2.KDomestic).toBe(615);
  });

  it('代表路線の対実績倍率: 幹線と歪みのあった非羽田 OD が 0.8〜1.2 に入る', () => {
    const cases: [string, string, number][] = [
      ['TYO', 'SPK', 28250], ['TYO', 'FUK', 26152], ['TYO', 'OKA', 19235], // v1 で 0.56 倍だった幹線
      ['NGO', 'SPK', 3909], // v1 の機械的試算で 1.97 倍
      ['FUK', 'OKA', 6347], // 同 0.52 倍
      ['FUK', 'SPK', 2651],
    ];
    for (const [o, d, actual] of cases) {
      const ratio = demandFrom(o, d) / actual;
      expect(ratio, `${o}-${d}`).toBeGreaterThanOrEqual(0.8);
      expect(ratio, `${o}-${d}`).toBeLessThanOrEqual(1.2);
    }
  });

  it('那覇―石垣は構造的残差として記録する（v1 の 0.05 倍からは改善するが 1.0 には届かない）', () => {
    // 区間旅客（本土からの乗継・観光流動）が本体の路線で、両端住民の OD 重力では
    // 表せない。計画書 §11 の残課題（離島区間の流動の別扱い）として値を固定する
    const ratio = demandFrom('OKA', 'ISG') / 2820;
    expect(ratio).toBeGreaterThan(0.05);
    expect(ratio).toBeLessThan(0.25);
  });

  it('fit 18 路線の物差し: 中央対数誤差 ≤ 0.10、帯域（0.7〜1.3）≥ 16/18、Spearman ≥ 0.95', () => {
    const rows = FIT.map(([o, d, actual]) => ({ o, d, actual, pred: demandFrom(o, d) }));
    const medAbsLog = median(rows.map((r) => Math.abs(Math.log(r.pred / r.actual))));
    const inBand = rows.filter((r) => r.pred / r.actual >= 0.7 && r.pred / r.actual <= 1.3).length;
    const rho = spearman(rows.map((r) => r.actual), rows.map((r) => r.pred));
    expect(medAbsLog).toBeLessThanOrEqual(0.10);
    expect(inBand).toBeGreaterThanOrEqual(16);
    expect(rho).toBeGreaterThanOrEqual(0.95);
  });

  it('出発市場ごとの合計比: TYO と FUK は 0.9〜1.1、NGO・OSA は 1.25 以下', () => {
    for (const [origin, lo, hi] of [['TYO', 0.9, 1.1], ['FUK', 0.9, 1.1], ['NGO', 0.85, 1.25], ['OSA', 0.85, 1.25]] as const) {
      const rows = FIT.filter(([o]) => o === origin);
      const ratio = rows.reduce((s, [o, d]) => s + demandFrom(o, d), 0) / rows.reduce((s, [, , a]) => s + a, 0);
      expect(ratio, origin).toBeGreaterThanOrEqual(lo);
      expect(ratio, origin).toBeLessThanOrEqual(hi);
    }
  });

  it('年度 holdout（2024 年）でも崩れない: 中央対数誤差 ≤ 0.12', () => {
    const rows = HOLDOUT.map(([o, d, actual]) => ({ actual, pred: demandFrom(o, d) }));
    const medAbsLog = median(rows.map((r) => Math.abs(Math.log(r.pred / r.actual))));
    expect(medAbsLog).toBeLessThanOrEqual(0.12);
  });

  it('季節係数は v1 と同じ目的地プロファイルを使う（年間平均はほぼ 1 のまま）', () => {
    // routeDemand は年間平均ベース。季節・曜日は routeDemandSummary 側の従来経路で掛かるため、
    // ここでは v2 でも routeDemand 自体が day に依存しないことだけを固定する
    const c = nodeCompany('TYO');
    const d1 = routeDemand(c, destinationDef('SPK'), 1)!;
    c.day = 200;
    const d2 = routeDemand(c, destinationDef('SPK'), 1)!;
    expect(d2).toBe(d1);
  });
});
