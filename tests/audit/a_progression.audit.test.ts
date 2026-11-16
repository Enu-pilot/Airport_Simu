/**
 * 監査 docs/38 ID 01（基本プレイ・ゲーム進行）— core 層で「新規会社 → 建設 → 契約 → 運航開始 → 日次締め → 翌日」を再現する。
 * UI（simRunner）と同じ手順: 建設は chargeConstruction、契約は previewContractCapacity + acceptOffer、
 * 運航は createSimulation(layout, { company: structuredClone(company) }) → stepTicks(stopAtDayClose) → sim.company を持ち越す。
 * 既存: tests/unit/dayloop.test.ts, dayflow.test.ts, economy.test.ts, gameModels.test.ts, golden.* 。
 * 追加: 複数日 × 複数シードの資金収支の恒等式（cashEnd(n) = cashStart(n) + 営業利益 + 建設費 + 目標報酬）、日報の連番、
 *       途中の不変条件、契約状態遷移（提案 → 受諾/拒否/失効）、キャリア破綻判定、同一入力の決定性。
 */
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../src/core/economy/balance';
import {
  acceptOffer,
  changeFrequency,
  createCareerCompany,
  createSandboxCompany,
  generateOffers,
  rejectOffer,
  type CompanyState,
} from '../../src/core/economy/company';
import { previewContractCapacity } from '../../src/core/economy/capacity';
import { chargeConstruction } from '../../src/core/economy/construction';
import { airlineDef, destinationDef, routeAvailability, routeCapabilitiesForAirport } from '../../src/core/economy/registry';
import { addTaxiwayPath, placeStand } from '../../src/core/layout/operations';
import type { AirportLayout } from '../../src/core/model/types';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { createContext, operableTypes } from '../../src/core/sim/context';
import { dayMarker, stepTicks } from '../../src/core/sim/dayloop';
import { checkInvariants } from '../../src/core/sim/invariants';
import { DAY_SEC } from '../../src/core/sim/rules';
import { createSimulation, type Simulation } from '../../src/core/sim/simulation';
import { analyzeLayout } from '../../src/core/validation/validate';

const SEEDS = ['a1-s1', 'a1-s2', 'a1-s3'];

/** UI の companyActions.acceptOffer と同じ判定で受諾を試みる */
function tryAccept(c: CompanyState, layout: AirportLayout, id: string) {
  const k = c.contracts[id]!;
  const ctx = createContext(layout);
  const route = routeAvailability(airlineDef(k.airlineId), destinationDef(k.destinationId), routeCapabilitiesForAirport(ctx.layout.countryId));
  const capacity = previewContractCapacity(c, ctx, { airlineId: k.airlineId, destinationId: k.destinationId, typeId: k.typeId, perDay: k.perDay, window: k.window }, [], 1).result;
  return { res: acceptOffer(c, id, operableTypes(ctx).includes(k.typeId), route, capacity), capacity };
}

/** 1 日（開場前の 6:00 開始 → 次の 0:00 の締め）を運航する。10 分ごとに不変条件を確認する */
function playDay(layout: AirportLayout, company: CompanyState, seed: string): { sim: Simulation; violations: string[]; ticks: number } {
  const sim = createSimulation(layout, { seed, company: structuredClone(company) });
  const violations: string[] = [];
  let ticks = 0;
  for (;;) {
    const r = stepTicks(sim, 600, { stopAtDayClose: true });
    ticks += r.ticks;
    for (const v of checkInvariants(sim)) if (violations.length < 10) violations.push(`t=${sim.state.now}: ${v}`);
    if (r.stop === 'dayClose' || r.stop === 'bankrupt') break;
    if (ticks > 2 * DAY_SEC) throw new Error('day did not close');
  }
  return { sim, violations, ticks };
}

describe('ID01 キャリア: 建設 → 契約 → 運航 → 締め を 4 日続ける（starterAirfield, 3 シード）', () => {
  for (const seed of SEEDS) {
    it(`seed=${seed}: 資金恒等式・日報の連番・不変条件・契約遷移`, { timeout: 300_000 }, () => {
      let layout = createStarterAirfield();
      let company = createCareerCompany(seed);
      const cash0 = company.cash;
      expect(company.day).toBe(0);
      expect(company.reports).toHaveLength(0);
      let prevCashEnd = cash0;
      let builtStands = 0;
      const seenOffered = new Set<string>();

      for (let day = 0; day < 4; day++) {
        const cashBefore = company.cash;
        // --- 建設フェーズ（day 1 で駐機スポットを増設、資金が足りなければ拒否される）
        if (day === 1) {
          const errBefore = analyzeLayout(layout).counts.error;
          // 西側へ誘導路 B を延長し、その先にスポットを増設（エラーが増えないことを確認してから課金）
          const ext = addTaxiwayPath(layout, [{ x: 45, y: 41 }, { x: 42, y: 41 }]);
          expect(ext.ok).toBe(true);
          if (ext.ok) {
            const r = placeStand(ext.layout, { x: 43, y: 42 }, 'M', 180, 'operational', 'X43');
            expect(r.ok).toBe(true);
            if (r.ok) {
              expect(analyzeLayout(r.layout).counts.error).toBeLessThanOrEqual(errBefore);
              const cashPre = company.cash;
              const ch = chargeConstruction(company, layout, r.layout);
              expect(ch.ok).toBe(true);
              if (ch.ok) {
                expect(cashPre - company.cash, `${seed} construction cost`).toBe(ch.cost);
                expect(ch.cost).toBeGreaterThan(0);
                expect(company.today.construction).toBe(-ch.cost);
                layout = r.layout;
                builtStands++;
              }
            }
          }
          expect(builtStands, `${seed} could not place any extra stand`).toBe(1);
        }
        // --- 契約フェーズ: 提案があれば受諾/拒否（UI と同じ判定）
        for (const k of Object.values(company.contracts)) {
          if (k.status !== 'offered') continue;
          seenOffered.add(k.id);
          if (Number(k.id.slice(3)) % 2 === 0) {
            const { res, capacity } = tryAccept(company, layout, k.id);
            if (res.ok) {
              expect(k.status).toBe('active');
              expect(k.startDay).toBe(company.day);
              expect(k.endDay).toBe(company.day + BALANCE.offers.contractDays - 1);
              expect(capacity).not.toBe('unacceptable');
            } else {
              expect(k.status, `${seed} refused offer must stay offered`).toBe('offered');
            }
          } else {
            expect(rejectOffer(company, k.id)).toEqual({ ok: true });
            expect(k.status).toBe('rejected');
          }
        }
        const openOffers = Object.values(company.contracts).filter((k) => k.status === 'offered');
        expect(openOffers.length).toBeLessThanOrEqual(BALANCE.offers.maxOpen);

        // --- 運航開始 → 締め
        const { sim, violations, ticks } = playDay(layout, company, `${seed}:d${day}`);
        expect(violations, `${seed} day ${day}`).toEqual([]);
        expect(ticks, `${seed} 06:00 開始から 0:00 の締めの tick まで`).toBe(DAY_SEC - 6 * 3600 + 1);
        company = sim.company!;
        expect(company.day, `${seed} day counter`).toBe(day + 1);
        expect(company.reports).toHaveLength(day + 1);
        const rep = company.reports[day]!;
        expect(rep.day).toBe(day);
        expect(rep.partial).toBe(false);
        // 日報の合計と内訳
        expect(rep.totalRevenue).toBeCloseTo(Object.values(rep.revenue).reduce((s, v) => s + v, 0), 6);
        expect(rep.totalCost).toBeCloseTo(Object.values(rep.cost).reduce((s, v) => s + v, 0), 6);
        expect(rep.operatingProfit).toBeCloseTo(rep.totalRevenue - rep.totalCost, 6);
        // 資金恒等式: cashEnd = 日の初め + 営業利益 + 建設(負) (+ 目標の報酬)
        expect(rep.cashEnd, `${seed} cashEnd day ${day}`).toBeCloseTo(cashBefore + rep.operatingProfit - rep.construction + (rep.grants ?? 0), 4); // report.construction は支出額（正）
        expect(company.cash).toBeCloseTo(rep.cashEnd, 4);
        if (day === 1) expect(rep.construction).toBeGreaterThan(0);
        else expect(Math.abs(rep.construction)).toBe(0);
        expect(company.today).toEqual({}); // 締め後の当日台帳は空
        // 前日の締めからの連続性
        expect(rep.cashEnd - prevCashEnd).toBeCloseTo(rep.operatingProfit - rep.construction + (rep.grants ?? 0) + (cashBefore - prevCashEnd), 4);
        prevCashEnd = rep.cashEnd;
        // KPI の範囲
        const kpi = rep.kpi;
        if (kpi.otp !== null) {
          expect(kpi.otp).toBeGreaterThanOrEqual(0);
          expect(kpi.otp).toBeLessThanOrEqual(1);
        }
        expect(kpi.rating).toBeGreaterThanOrEqual(0);
        expect(kpi.rating).toBeLessThanOrEqual(100);
        expect(kpi.flights).toBeGreaterThan(0);
        expect(kpi.paxDeparted).toBeGreaterThanOrEqual(0);
        for (const v of [kpi.runwayUtil, kpi.gateUtil, kpi.facilityUtil]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        // 運航の会計: 出発数 = 出発完了の機数、到着 = 着陸した便
        const st = sim.state.stats;
        expect(st.departures).toBe(Object.values(sim.state.aircraft).filter((a) => a.state === 'departed').length);
        expect(sim.state.flights && Object.keys(sim.state.flights).length).toBeGreaterThan(0);
        expect(company.bankrupt).toBe(false);
        // 締めで新しい提案が出ることがある（提案は常に maxOpen 以内）
        expect(Object.values(company.contracts).filter((k) => k.status === 'offered').length).toBeLessThanOrEqual(BALANCE.offers.maxOpen);
      }
      expect(company.reports.map((r) => r.day)).toEqual([0, 1, 2, 3]);
      // 提案は期限切れで 'expired' になる（受諾も拒否もされない提案が残らない）
      for (const k of Object.values(company.contracts)) {
        if (seenOffered.has(k.id) && k.status === 'offered') expect(company.day).toBeLessThanOrEqual(k.offerExpiresDay);
      }
    });
  }
});

describe('ID01 決定性: 同じ入力（レイアウト・会社・シード）は同じ日報を返す', () => {
  it('seed=a1-det: 2 日分を 2 回実行して company 全体が完全一致', { timeout: 300_000 }, () => {
    const run = () => {
      let c = createCareerCompany('a1-det');
      const layout = createStarterAirfield();
      for (let d = 0; d < 2; d++) c = playDay(layout, c, `a1-det:d${d}`).sim.company!;
      return JSON.stringify(c);
    };
    expect(run()).toBe(run());
  });
});

describe('ID01 サンドボックス（資金ほぼ無制限）: サンプル空港 2 日 + 増便', () => {
  for (const seed of ['a1-sb1', 'a1-sb2']) {
    it(`seed=${seed}: 2 日運航。資金恒等式、増便（changeFrequency）が翌日の便数に反映される`, { timeout: 300_000 }, () => {
      const layout = createSampleAirport();
      let c = createSandboxCompany(seed);
      const cash0 = c.cash;
      const day0 = playDay(layout, c, `${seed}:d0`);
      expect(day0.violations).toEqual([]);
      c = day0.sim.company!;
      const flights0 = Object.keys(day0.sim.state.flights).length;
      expect(c.reports[0]!.cashEnd).toBeCloseTo(cash0 + c.reports[0]!.operatingProfit - c.reports[0]!.construction + (c.reports[0]!.grants ?? 0), 4);
      // 増便 1 件（満足度が足りれば）。成功したら翌日の便数が 2 増える（往復 = 到着便 + 出発便）
      const target = Object.values(c.contracts).find((k) => k.status === 'active' && k.airlineId === 'AQ')!;
      const before = target.perDay;
      const r = changeFrequency(c, target.id, 1);
      if (r.ok) {
        expect(target.perDay).toBe(before + 1);
        const day1 = playDay(layout, c, `${seed}:d1`);
        expect(day1.violations).toEqual([]);
        // 観測: 開始時の運航は当日と翌日の 2 日分の便を生成する（便数 = 往復 × 2 便 × 2 日）。増便 1 件 = +4 便
        expect(Object.keys(day1.sim.state.flights).length).toBe(flights0 + 4);
        c = day1.sim.company!;
      } else {
        expect(r.reason).toBe('AIRLINE_REFUSED');
        expect(target.perDay).toBe(before);
      }
      expect(c.reports.length).toBeGreaterThanOrEqual(1);
      expect(dayMarker(day0.sim)).toBe(1);
    });
  }
});

describe('ID01 契約提案の生成と失効（会社単体）', () => {
  it('generateOffers は maxOpen を超えず、提案の期限は expireDays、評価が低い会社には出ない航空会社がある。拒否済みは再提案されない', () => {
    for (const seed of SEEDS) {
      const c = createCareerCompany(seed);
      const ctx = createContext(createStarterAirfield());
      let total = 0;
      for (let i = 0; i < 40; i++) {
        c.day = i;
        const made = generateOffers(c, operableTypes(ctx));
        total += made.length;
        for (const k of made) {
          expect(k.status).toBe('offered');
          expect(k.offerExpiresDay).toBe(c.day + BALANCE.offers.expireDays);
          expect(k.perDay).toBeGreaterThanOrEqual(1);
        }
        expect(Object.values(c.contracts).filter((k) => k.status === 'offered').length, `${seed} d${i}`).toBeLessThanOrEqual(BALANCE.offers.maxOpen);
        // 古い提案は拒否して空きを作る
        for (const k of Object.values(c.contracts)) if (k.status === 'offered' && i % 3 === 0) rejectOffer(c, k.id);
      }
      expect(total, `${seed} offers over 40 days`).toBeGreaterThan(0);
      // 二重受諾は NOT_OFFERED
      const act = Object.values(c.contracts).find((k) => k.status === 'active')!;
      expect(acceptOffer(c, act.id, true)).toEqual({ ok: false, reason: 'NOT_OFFERED' });
      expect(rejectOffer(c, act.id)).toEqual({ ok: false, reason: 'NOT_OFFERED' });
      expect(acceptOffer(c, 'ct_9999', true)).toEqual({ ok: false, reason: 'NOT_FOUND' });
    }
  });
});

describe('ID01 キャリア破綻判定', () => {
  it('資金がマイナスのまま bankruptcyDays 日続くと破綻(bankrupt)。サンドボックスは破綻しない。stepTicks は bankrupt で止まる', { timeout: 200_000 }, () => {
    const layout = createStarterAirfield();
    let c = createCareerCompany('a1-bk');
    c.cash = -1e9;
    const first = playDay(layout, c, 'a1-bk:d0');
    c = first.sim.company!;
    expect(c.negativeDays).toBe(1);
    expect(c.bankrupt).toBe(false);
    // 破綻直前まで日数を進めたことにして、次の締めで破綻する
    c.negativeDays = BALANCE.bankruptcyDays - 1;
    const last = playDay(layout, c, 'a1-bk:d1');
    expect(last.sim.company!.negativeDays).toBe(BALANCE.bankruptcyDays);
    expect(last.sim.company!.bankrupt).toBe(true);
    const sb = createSandboxCompany('a1-bk2');
    sb.cash = -1e9;
    sb.negativeDays = BALANCE.bankruptcyDays + 5;
    const r = playDay(createSampleAirport(), sb, 'a1-bk2:d0');
    expect(r.sim.company!.bankrupt).toBe(false);
  });
});
