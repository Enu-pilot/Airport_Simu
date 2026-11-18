import { describe, expect, it } from 'vitest';
import { addContract, createSandboxCompany, type CompanyState } from '../../../src/core/economy/company';
import { planDay } from '../../../src/core/economy/planning';
import { planConnections } from '../../../src/core/economy/hub';
import { buildTerminalModel } from '../../../src/core/terminal/model';
import { analyzeHub } from '../../../src/core/terminal/hub';
import { transferAirport } from '../transferLayout';

function bankCompany(seed = 'bank-1'): CompanyState {
  const c = createSandboxCompany(seed);
  c.features = { hub: true };
  c.hub = {
    banks: [{ id: 'b1', arriveFromMin: 480, arriveToMin: 540, departFromMin: 600, departToMin: 660 }],
    maxConnectMin: 240,
  };
  addContract(c, {
    airlineId: 'HB', destinationId: 'KTA', typeId: 'B737-800', perDay: 3, window: 'any',
    feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0,
    bankId: 'b1', transferShare: 0.4,
  });
  addContract(c, {
    airlineId: 'HB', destinationId: 'TYO', typeId: 'B737-800', perDay: 3, window: 'any',
    feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0,
    bankId: 'b1', transferShare: 0.4,
  });
  return c;
}

describe('バンクと接続計画（フェーズ 4 §5.3・§5.7）', () => {
  it('バンク契約の便は到着・出発の時間帯に集まる', () => {
    const c = bankCompany();
    const plan = planDay(c, 0);
    const banked = plan.flights.filter((f) => f.bankId === 'b1');
    expect(banked.length).toBeGreaterThan(0);
    for (const f of banked) {
      expect(f.arrivalAt).toBeGreaterThanOrEqual(480 * 60);
      expect(f.arrivalAt).toBeLessThanOrEqual(540 * 60);
      expect(f.departureAt).toBeGreaterThanOrEqual(600 * 60);
      expect(f.departureAt).toBeLessThanOrEqual(660 * 60 + 15 * 60); // 折り返しが長い便の余裕
    }
    // バンクでない既定の契約の便には bankId が付かない
    expect(plan.flights.some((f) => f.bankId === undefined)).toBe(true);
  });

  it('planConnections: MCT 以上の間隔でのみ接続し、出発便の空席を超えない', () => {
    const c = bankCompany();
    const plan = planDay(c, 0);
    const l = transferAirport();
    const hub = analyzeHub(l, buildTerminalModel(l));
    expect(hub.mct.DD).not.toBeNull();
    planConnections(plan, c, hub);
    let total = 0;
    for (const f of plan.flights) {
      expect(f.transferIn ?? 0).toBeLessThanOrEqual(Math.max(0, f.seats - f.depPax));
      for (const conn of f.connections ?? []) {
        total += conn.pax;
        const dep = plan.flights.find((d) => d.key === conn.depKey)!;
        expect(dep.departureAt - f.arrivalAt).toBeGreaterThanOrEqual(hub.mct[conn.kind]!);
        expect(dep.departureAt - f.arrivalAt).toBeLessThanOrEqual(240 * 60);
      }
      // 乗継の総量は到着旅客 × 乗継率 × 1.1（乱数の上限）を超えない
      if (f.connections) {
        const sum = f.connections.reduce((s, x) => s + x.pax, 0);
        expect(sum).toBeLessThanOrEqual(Math.ceil(f.arrPax * 0.4 * 1.1));
      }
    }
    expect(total).toBeGreaterThan(0);
  });

  it('ハブが無効な会社ではバンクも接続も付かない', () => {
    const c = bankCompany('bank-off');
    delete c.features;
    const plan = planDay(c, 0);
    expect(plan.flights.every((f) => f.bankId === undefined)).toBe(true);
    const l = transferAirport();
    planConnections(plan, c, analyzeHub(l, buildTerminalModel(l)));
    expect(plan.flights.every((f) => f.connections === undefined)).toBe(true);
  });
});
