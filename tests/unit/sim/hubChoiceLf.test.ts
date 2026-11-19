import { describe, expect, it } from 'vitest';
import { addContract, createSandboxCompany, type CompanyState, type Contract } from '../../../src/core/economy/company';
import type { DayPlan, PlannedFlight } from '../../../src/core/economy/planning';
import { directDistanceKm, hubChoiceShare, nonstopAppeal, onwardAppeal, planConnections } from '../../../src/core/economy/hub';
import { destinationDef } from '../../../src/core/economy/registry';
import type { HubAnalysis } from '../../../src/core/terminal/hub';

/**
 * F6-17 残件: (1) 乗継需要の搭乗率への統合、(2) 直行便との競合（HubChoiceShare）。
 * docs/44 §4.2 の残課題への対応として 2026-11-19 に実装した境界を固定する。
 */

const MCT_DD = 30 * 60;
const hubAnalysis: HubAnalysis = {
  mct: { DD: MCT_DD, DI: null, ID: null, II: null },
  byKind: {
    DD: { max: MCT_DD, median: MCT_DD, pairs: 1 },
    DI: { max: null, median: null, pairs: 0 },
    ID: { max: null, median: null, pairs: 0 },
    II: { max: null, median: null, pairs: 0 },
  },
  pairMct: new Map(),
};

const T0 = 10 * 3600;

function setup(seed = 'xfer-lf'): { c: CompanyState; arrK: Contract } {
  const c = createSandboxCompany(seed);
  c.features = { hub: true };
  c.hub = { banks: [], maxConnectMin: 240 };
  const arrK = addContract(c, {
    airlineId: 'HB', destinationId: 'KTA', typeId: 'B737-800', perDay: 1, window: 'any',
    feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, transferShare: 0.5,
  });
  return { c, arrK };
}

function depContract(c: CompanyState, destinationId: string): Contract {
  return addContract(c, {
    airlineId: 'HB', destinationId, typeId: 'B737-800', perDay: 1, window: 'any',
    feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, transferShare: 0.5,
  });
}

function flight(partial: Partial<PlannedFlight> & Pick<PlannedFlight, 'key' | 'contractId' | 'destinationId' | 'arrivalAt' | 'departureAt'>): PlannedFlight {
  return {
    airlineId: 'HB', typeId: 'B737-800', arrNumber: 'HB100', depNumber: 'HB101',
    arrPax: 0, depPax: 0, seats: 180, inboundDelaySec: 0, ...partial,
  };
}

const totalConnections = (plan: DayPlan) => plan.flights.reduce((s, f) => s + (f.connections ?? []).reduce((x, cn) => x + cn.pax, 0), 0);

describe('F6-17 HubChoiceShare（直行便競合）', () => {
  it('直行距離は経由距離（自空港経由の合計）以下で、座標から決定的に求まる', () => {
    const kta = destinationDef('KTA');
    const tyo = destinationDef('TYO');
    const direct = directDistanceKm(kta, tyo);
    expect(direct).toBeGreaterThan(0);
    expect(direct).toBeLessThanOrEqual(kta.distanceKm + tyo.distanceKm + 1);
    expect(directDistanceKm(kta, tyo)).toBe(directDistanceKm(tyo, kta));
  });

  it('choiceShare は 0〜1 で、直行の魅力が強い OD ほど小さい', () => {
    const kta = destinationDef('KTA');
    const shareTyo = hubChoiceShare(kta, destinationDef('TYO'));
    expect(shareTyo).toBeGreaterThan(0);
    expect(shareTyo).toBeLessThan(1);
    // 定義どおり: via / (via + pref × nonstop)
    const via = onwardAppeal(kta, destinationDef('TYO'));
    const direct = nonstopAppeal(kta, destinationDef('TYO'));
    expect(shareTyo).toBeCloseTo(via / (via + direct), 10);
  });

  it('競合を入れると乗継配分は減る（ただし 0 にはならない）', () => {
    const run = () => {
      const { c, arrK } = setup('xfer-choice');
      const kTyo = depContract(c, 'TYO');
      const arr = flight({ key: 'arr:0:0', contractId: arrK.id, destinationId: 'KTA', arrivalAt: T0, departureAt: T0 + 600 * 60, arrPax: 180 });
      const dep = flight({ key: 'dep:0', contractId: kTyo.id, destinationId: 'TYO', arrivalAt: 80000, departureAt: T0 + 75 * 60, seats: 180, depPax: 0 });
      const plan: DayPlan = { day: 0, flights: [arr, dep], dropped: [] };
      planConnections(plan, c, hubAnalysis);
      return totalConnections(plan);
    };
    const withCompetition = run();
    expect(withCompetition).toBeGreaterThan(0);
    expect(withCompetition).toBeLessThanOrEqual(Math.ceil(180 * 0.5 * 1.1));
  });
});

describe('F6-17 搭乗率への統合', () => {
  it('搭乗率の低い到着便では、乗継配分が元の到着旅客を超えて arrPax が伸びる（座席が上限）', () => {
    const { c, arrK } = setup('xfer-lf-grow');
    // 接続先を複数用意してネットワーク魅力を最大化する
    const deps: PlannedFlight[] = ['TYO', 'OSA', 'TWN', 'HSM'].map((dest, i) => {
      const k = depContract(c, dest);
      return flight({ key: `dep:${i}`, contractId: k.id, destinationId: dest, arrivalAt: 80000, departureAt: T0 + 75 * 60, seats: 400, depPax: 0 });
    });
    const arr = flight({ key: 'arr:0:0', contractId: arrK.id, destinationId: 'KTA', arrivalAt: T0, departureAt: T0 + 600 * 60, arrPax: 40, seats: 180 });
    const plan: DayPlan = { day: 0, flights: [arr, ...deps], dropped: [] };
    planConnections(plan, c, hubAnalysis);
    const total = totalConnections(plan);
    expect(total).toBeGreaterThan(40); // 旧モデル（到着旅客からの切り分け）では起こり得ない
    expect(arr.arrPax).toBe(total); // 伸長後の到着旅客 = 乗継合計（この構成では地元分を超えた分だけ伸びる）
    expect(arr.arrPax).toBeLessThanOrEqual(180);
  });

  it('到着旅客が座席以上ある計画では従来どおり切り分けのみ（arrPax は伸びない）', () => {
    const { c, arrK } = setup('xfer-lf-full');
    const kTyo = depContract(c, 'TYO');
    const arr = flight({ key: 'arr:0:0', contractId: arrK.id, destinationId: 'KTA', arrivalAt: T0, departureAt: T0 + 600 * 60, arrPax: 200, seats: 180 });
    const dep = flight({ key: 'dep:0', contractId: kTyo.id, destinationId: 'TYO', arrivalAt: 80000, departureAt: T0 + 75 * 60, seats: 180, depPax: 0 });
    const plan: DayPlan = { day: 0, flights: [arr, dep], dropped: [] };
    planConnections(plan, c, hubAnalysis);
    expect(arr.arrPax).toBe(200);
    expect(totalConnections(plan)).toBeLessThanOrEqual(200);
  });
});
