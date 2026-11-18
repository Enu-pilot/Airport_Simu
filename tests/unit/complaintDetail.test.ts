import { describe, expect, it } from 'vitest';
import type { FlightRecord } from '../../src/core/analytics/records';
import { addContract, createCompany, type CompanyState } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { airlineScorecard, type ScoreComponent } from '../../src/core/economy/airlineScore';
import { findDestination } from '../../src/core/economy/registry';
import { analyzeDayPlan, planDayWithDemand } from '../../src/core/economy/planning';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createContext } from '../../src/core/sim/context';
import { complaintDetailText } from '../../src/i18n/ja';

/**
 * 不満の内訳表示（表示のみ）: 要素の事実に絶対数・最悪路線が分かれて入り、
 * 統一ビルダーが「何が・どれだけ足りないか」を一行で具体化することを検証する。
 * スコア・レベルは従来の計算のまま変わらないことも併せて確認する。
 */

let seq = 0;
function record(partial: Partial<FlightRecord>): FlightRecord {
  seq += 1;
  return {
    aircraftId: `ac${seq}`, arrNumber: `A${seq}`, depNumber: `D${seq}`, airlineId: 'RJ', contractId: null, typeId: 'regional70',
    result: 'completed', causes: [], arrRunway: null, depRunway: null, standId: null, gateId: null,
    arrScheduled: 0, landedAt: 0, blockIn: 0, readyAt: 0, blockOut: 0, depScheduled: 0, takeoffAt: 0,
    airborneHoldSec: 0, taxiInSec: 0, taxiOutSec: 0, groundDistM: 0, groundStopSec: 0,
    seats: 70, paxBooked: 0, paxBoarded: 0, paxMissed: 0, paxArrived: 0,
    bagsLoaded: 0, bagsLeft: 0, taskSec: {}, taskBlockedSec: 0, revenue: 0, disruptions: [],
    ...partial,
  };
}

const comp = (partial: Partial<ScoreComponent> & Pick<ScoreComponent, 'key'>): ScoreComponent => ({ level: 'bad', score: 0, facts: {}, ...partial });

describe('complaintDetailText: 不満の内訳の一行', () => {
  it('折り返し: 標準・平均・超過分・対象便数を示す', () => {
    const text = complaintDetailText(comp({ key: 'turnaround', facts: { value: 17, target: 45, n: 12 } }));
    expect(text).toBe('折り返し: 標準 45分に対し平均 62分（+17分、対象 12便）');
  });

  it('旅客体験: 乗り遅れ率と積み残し率を分け、絶対数を併記する', () => {
    const text = complaintDetailText(comp({ key: 'pax', facts: { value: 0.05, target: 0.1, missedRate: 0.05, leftRate: 0.1, missedCount: 10, bookedCount: 200, leftCount: 10, bagsCount: 100, n: 3 } }));
    expect(text).toBe('旅客体験: 乗り遅れ 5%（10/200人）・手荷物の積み残し 10%（10/100個）');
  });

  it('需要: 基準との差（ポイント）と最も低い路線を示す', () => {
    const text = complaintDetailText(comp({ key: 'demand', facts: { value: 0.62, target: 0.78, n: 4, worstRoute: '北九州', worstRouteLf: 0.4 } }));
    expect(text).toBe('需要（搭乗率）: 搭乗率 62%（基準 78%、16ポイント不足）。最も低いのは 北九州線 40%');
  });

  it('定時性: 要求との差と遅延区間数を示す', () => {
    const text = complaintDetailText(comp({ key: 'otp', facts: { value: 0.72, target: 0.85, n: 40, lateCount: 11 } }));
    expect(text).toBe('定時性: 定時率 72%（要求 85%、13ポイント不足、遅延 11/40 区間）');
  });

  it('スポット・料金・枠・機材も事実の範囲で具体化する', () => {
    expect(complaintDetailText(comp({ key: 'stand', facts: { value: 2, target: 1, n: 3 } }))).toBe('スポット・ゲート: スポット競合 2便・ゲートのないスポットへの割当 1便・スポット待ちの遅れ 3便');
    expect(complaintDetailText(comp({ key: 'fees', facts: { value: 1.3, target: 1.24 } }))).toBe('料金: 料金倍率 ×1.30（割引後 ×1.24、標準より 24% 高い）');
    expect(complaintDetailText(comp({ key: 'slots', facts: { value: 2, n: 1 } }))).toBe('枠（時間帯）: 希望の時間帯の枠に入らない便 2便・運用時間・時間帯に入らない契約 1件');
  });
});

describe('airlineScore: 表示用 facts の露出（計算は不変）', () => {
  it('旅客体験: 率が分離され、絶対数が入る。スコアは従来どおり', () => {
    const c = createCompany('career', 'complaint-pax');
    const layout = createSampleAirport();
    const ctx = createContext(layout);
    const plan = planDayWithDemand(c, 0, 1, ctx.types);
    const recs = [
      record({ paxBooked: 120, paxMissed: 6, bagsLoaded: 50, bagsLeft: 2 }),
      record({ paxBooked: 80, paxMissed: 4, bagsLoaded: 40, bagsLeft: 8 }),
    ];
    const cards = airlineScorecard({ company: c, ctx, records: recs, plan, analysis: analyzeDayPlan(plan, ctx) });
    const pax = cards.find((x) => x.airlineId === 'RJ')!.components.find((x) => x.key === 'pax')!;
    expect(pax.facts.value).toBeCloseTo(0.05);
    expect(pax.facts.target).toBeCloseTo(0.1);
    expect(pax.facts.missedRate).toBeCloseTo(0.05);
    expect(pax.facts.leftRate).toBeCloseTo(0.1);
    expect(pax.facts.missedCount).toBe(10);
    expect(pax.facts.bookedCount).toBe(200);
    expect(pax.facts.leftCount).toBe(10);
    expect(pax.facts.bagsCount).toBe(100);
    // 従来の計算: 100 − (0.05 + 0.1) × 800 → 0（クランプ）、レベル bad
    expect(pax.score).toBe(0);
    expect(pax.level).toBe('bad');
    expect(complaintDetailText(pax)).toBe('旅客体験: 乗り遅れ 5%（10/200人）・手荷物の積み残し 10%（10/100個）');
  });

  it('需要: 路線別の最悪行先とその搭乗率が入る。スコアは従来どおり', () => {
    const c: CompanyState = createCompany('career', 'complaint-demand');
    c.city = defaultCity('regional');
    c.market = { version: 1, routes: {} };
    const base = { feeDiscount: 0, startDay: 0, endDay: 999, status: 'active' as const, offerExpiresDay: 0, window: 'any' as const };
    const good = addContract(c, { ...base, airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 1 });
    const weak = addContract(c, { ...base, airlineId: 'RJ', destinationId: 'TWN', typeId: 'regional70', perDay: 1 });
    const layout = createSampleAirport();
    const ctx = createContext(layout);
    const plan = planDayWithDemand(c, 0, 1, ctx.types);
    const recs = [
      record({ contractId: good.id, seats: 70, paxBooked: 63, paxArrived: 63 }),
      record({ contractId: weak.id, seats: 70, paxBooked: 28, paxArrived: 28 }),
    ];
    const cards = airlineScorecard({ company: c, ctx, records: recs, plan, analysis: analyzeDayPlan(plan, ctx) });
    const demand = cards.find((x) => x.airlineId === 'RJ')!.components.find((x) => x.key === 'demand')!;
    expect(demand.facts.value).toBeCloseTo(182 / 280);
    expect(demand.facts.worstRoute).toBe(findDestination('TWN')!.name);
    expect(demand.facts.worstRouteLf).toBeCloseTo(0.4);
    expect(complaintDetailText(demand)).toContain(`最も低いのは ${findDestination('TWN')!.name}線 40%`);
  });
});
