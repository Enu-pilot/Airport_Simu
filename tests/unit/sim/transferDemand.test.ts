import { describe, expect, it } from 'vitest';
import { addContract, createSandboxCompany, type CompanyState, type Contract } from '../../../src/core/economy/company';
import type { DayPlan, PlannedFlight } from '../../../src/core/economy/planning';
import { connectionQuality, onwardAppeal, planConnections } from '../../../src/core/economy/hub';
import { destinationDef } from '../../../src/core/economy/registry';
import type { HubAnalysis } from '../../../src/core/terminal/hub';

/**
 * 乗継需要モデル（docs/44 §4.2、2026-11-19 変更）:
 * 固定率ではなく、接続ペアごとの潜在需要（目的地の魅力 × 接続品質）で乗継量が決まり、
 * 契約の transferShare は上限（キャップ）として働くことを確かめる。
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

const T0 = 10 * 3600; // 到着 10:00

function setup(seed = 'xfer-demand'): { c: CompanyState; arrK: Contract } {
  const c = createSandboxCompany(seed);
  c.features = { hub: true };
  c.hub = { banks: [], maxConnectMin: 240 };
  const arrK = addContract(c, {
    airlineId: 'HB', destinationId: 'KTA', typeId: 'B737-800', perDay: 1, window: 'any',
    feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, transferShare: 0.5,
  });
  return { c, arrK };
}

function depContract(c: CompanyState, destinationId: string, share = 0.5): Contract {
  return addContract(c, {
    airlineId: 'HB', destinationId, typeId: 'B737-800', perDay: 1, window: 'any',
    feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, transferShare: share,
  });
}

function flight(partial: Partial<PlannedFlight> & Pick<PlannedFlight, 'key' | 'contractId' | 'destinationId' | 'arrivalAt' | 'departureAt'>): PlannedFlight {
  return {
    airlineId: 'HB', typeId: 'B737-800', arrNumber: 'HB100', depNumber: 'HB101',
    arrPax: 0, depPax: 0, seats: 180, inboundDelaySec: 0, ...partial,
  };
}

/** 到着便（自便の出発は乗継窓の外に置く）+ 出発便群の計画を作る */
function planWith(arrK: Contract, arrPax: number, deps: PlannedFlight[]): DayPlan {
  const arr = flight({
    key: 'arr:0:0', contractId: arrK.id, destinationId: 'KTA',
    arrivalAt: T0, departureAt: T0 + 600 * 60, arrPax,
  });
  return { day: 0, flights: [arr, ...deps], dropped: [] };
}

function depFlight(key: string, k: Contract, gapMin: number, free = 180): PlannedFlight {
  const seats = Math.max(180, free);
  return flight({
    key, contractId: k.id, destinationId: k.destinationId,
    arrivalAt: 80000, departureAt: T0 + gapMin * 60, seats, depPax: seats - free,
  });
}

const totalConnections = (plan: DayPlan) => plan.flights.reduce((s, f) => s + (f.connections ?? []).reduce((x, cn) => x + cn.pax, 0), 0);
const paxTo = (plan: DayPlan, depKey: string) => {
  const arr = plan.flights.find((f) => f.key === 'arr:0:0')!;
  return arr.connections?.find((cn) => cn.depKey === depKey)?.pax ?? 0;
};

describe('接続品質と目的地の魅力（需要モデルの要素）', () => {
  it('connectionQuality: MCT ぎりぎり < 理想（MCT+45分）= 1 < 長すぎる接続は減衰', () => {
    expect(connectionQuality(MCT_DD, MCT_DD)).toBeCloseTo(0.7);
    expect(connectionQuality(MCT_DD + 45 * 60, MCT_DD)).toBeCloseTo(1);
    expect(connectionQuality(MCT_DD + 120 * 60, MCT_DD)).toBeLessThan(1);
    expect(connectionQuality(MCT_DD + 210 * 60, MCT_DD)).toBeLessThan(connectionQuality(MCT_DD + 120 * 60, MCT_DD));
  });

  it('onwardAppeal: 大都市（TYO）の方が小都市（MSK）より大きく、出発地が遠いほど小さい', () => {
    const kta = destinationDef('KTA');
    expect(onwardAppeal(kta, destinationDef('TYO'))).toBeGreaterThan(onwardAppeal(kta, destinationDef('MSK')) * 3);
    expect(onwardAppeal(destinationDef('YKH'), destinationDef('TYO'))).toBeLessThan(onwardAppeal(kta, destinationDef('TYO')));
  });
});

describe('乗継需要モデル（planConnections）', () => {
  it('(a) 接続品質が需要に効く: 理想的な間隔の便が、長すぎる接続の便より多く割り当てられる', () => {
    const { c, arrK } = setup();
    const kTyo = depContract(c, 'TYO');
    const plan = planWith(arrK, 200, [depFlight('dep:near', kTyo, 75), depFlight('dep:far', kTyo, 240)]);
    planConnections(plan, c, hubAnalysis);
    expect(paxTo(plan, 'dep:near')).toBeGreaterThan(paxTo(plan, 'dep:far') * 1.5);
    expect(paxTo(plan, 'dep:far')).toBeGreaterThan(0);
  });

  it('(b) 目的地の魅力が需要に効く: 同じ間隔・空席でも大都市行きに多く配分される', () => {
    const { c, arrK } = setup();
    const kTyo = depContract(c, 'TYO');
    const kMsk = depContract(c, 'MSK');
    const plan = planWith(arrK, 200, [depFlight('dep:tyo', kTyo, 75), depFlight('dep:msk', kMsk, 75)]);
    planConnections(plan, c, hubAnalysis);
    expect(paxTo(plan, 'dep:tyo')).toBeGreaterThan(paxTo(plan, 'dep:msk') * 2);
    expect(paxTo(plan, 'dep:msk')).toBeGreaterThan(0);
  });

  it('(c) バンク整合で需要が増える: 理想間隔に寄せた波の方が、長くばらけた波より乗継が多い', () => {
    const build = (gapMin: number) => {
      const { c, arrK } = setup('xfer-bank');
      const kMsk = depContract(c, 'MSK');
      const plan = planWith(arrK, 300, [depFlight('dep:0', kMsk, gapMin), depFlight('dep:1', kMsk, gapMin)]);
      planConnections(plan, c, hubAnalysis);
      return totalConnections(plan);
    };
    const banked = build(75);
    const spread = build(240);
    expect(banked).toBeGreaterThan(spread * 1.3);
  });

  it('(d) 需要ゼロの条件では乗継が発生しない', () => {
    // 契約に乗継の受け入れ（キャップ）がない
    {
      const { c, arrK } = setup();
      arrK.transferShare = 0;
      const kTyo = depContract(c, 'TYO');
      const plan = planWith(arrK, 200, [depFlight('dep:0', kTyo, 75)]);
      planConnections(plan, c, hubAnalysis);
      expect(totalConnections(plan)).toBe(0);
    }
    // ハブ未解放
    {
      const { c, arrK } = setup();
      delete c.features;
      const kTyo = depContract(c, 'TYO');
      const plan = planWith(arrK, 200, [depFlight('dep:0', kTyo, 75)]);
      planConnections(plan, c, hubAnalysis);
      expect(totalConnections(plan)).toBe(0);
    }
    // MCT 未満の間隔
    {
      const { c, arrK } = setup();
      const kTyo = depContract(c, 'TYO');
      const plan = planWith(arrK, 200, [depFlight('dep:0', kTyo, 20)]);
      planConnections(plan, c, hubAnalysis);
      expect(totalConnections(plan)).toBe(0);
    }
    // 最大乗継時間を超える間隔
    {
      const { c, arrK } = setup();
      const kTyo = depContract(c, 'TYO');
      const plan = planWith(arrK, 200, [depFlight('dep:0', kTyo, 300)]);
      planConnections(plan, c, hubAnalysis);
      expect(totalConnections(plan)).toBe(0);
    }
    // MCT が出せない空港（MCT_UNAVAILABLE）
    {
      const { c, arrK } = setup();
      const kTyo = depContract(c, 'TYO');
      const plan = planWith(arrK, 200, [depFlight('dep:0', kTyo, 75)]);
      planConnections(plan, c, { ...hubAnalysis, mct: { DD: null, DI: null, ID: null, II: null } });
      expect(totalConnections(plan)).toBe(0);
    }
    // 相手が別会社で乗継の受け入れがない（相互乗継でない）
    {
      const { c, arrK } = setup();
      const kOther = addContract(c, {
        airlineId: 'NP', destinationId: 'TYO', typeId: 'B737-800', perDay: 1, window: 'any',
        feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, transferShare: 0,
      });
      const d = depFlight('dep:0', kOther, 75);
      d.airlineId = 'NP';
      const plan = planWith(arrK, 200, [d]);
      planConnections(plan, c, hubAnalysis);
      expect(totalConnections(plan)).toBe(0);
    }
  });

  it('(e) 地元旅客を減らさず、上限（キャップ）と空席を超えない', () => {
    const { c, arrK } = setup();
    const kTyo = depContract(c, 'TYO');
    const dep = depFlight('dep:0', kTyo, 75, 60); // 空席 60
    const depPaxBefore = dep.depPax;
    const plan = planWith(arrK, 200, [dep]);
    planConnections(plan, c, hubAnalysis);
    expect(dep.depPax).toBe(depPaxBefore);
    expect(dep.transferIn ?? 0).toBeLessThanOrEqual(60);
    const total = totalConnections(plan);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(Math.ceil(200 * 0.5 * 1.1)); // キャップ × 到着旅客 × 揺らぎ上限
    expect(total).toBeLessThanOrEqual(200);
  });

  it('(f) 決定的: 同じ計画・同じ会社では同じ結果になる', () => {
    const run = () => {
      const { c, arrK } = setup('xfer-det');
      const kTyo = depContract(c, 'TYO');
      const kOsa = depContract(c, 'OSA');
      const plan = planWith(arrK, 250, [depFlight('dep:0', kTyo, 75), depFlight('dep:1', kOsa, 130), depFlight('dep:2', kTyo, 200)]);
      planConnections(plan, c, hubAnalysis);
      return plan.flights.map((f) => ({ key: f.key, connections: f.connections ?? null, transferIn: f.transferIn ?? 0 }));
    };
    expect(run()).toEqual(run());
  });

  it('接続先が増えるほど乗継割合が上限へ近づく（飽和型で、固定率ではない）', () => {
    const one = () => {
      const { c, arrK } = setup('xfer-sat');
      const kTyo = depContract(c, 'TYO');
      const plan = planWith(arrK, 400, [depFlight('dep:0', kTyo, 75, 400)]);
      planConnections(plan, c, hubAnalysis);
      return totalConnections(plan);
    };
    const many = () => {
      const { c, arrK } = setup('xfer-sat');
      const deps = [depContract(c, 'TYO'), depContract(c, 'OSA'), depContract(c, 'TWN'), depContract(c, 'HSM')].map((k, i) => depFlight(`dep:${i}`, k, 75, 400));
      const plan = planWith(arrK, 400, deps);
      planConnections(plan, c, hubAnalysis);
      return totalConnections(plan);
    };
    // 1 方面だけでも需要は出るが、ネットワークが広い方が多い。どちらもキャップ (0.5×400×1.1) 以内
    expect(one()).toBeGreaterThan(0);
    expect(many()).toBeGreaterThan(one());
    expect(many()).toBeLessThanOrEqual(Math.ceil(400 * 0.5 * 1.1));
  });
});
