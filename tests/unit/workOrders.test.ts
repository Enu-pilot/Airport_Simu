import { describe, expect, it } from 'vitest';
import { addWorkOrder, createCareerCompany, importCompany } from '../../src/core/economy/company';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSimulation } from '../../src/core/sim/simulation';
import { isWorkOrderNight, stepWorkOrders } from '../../src/core/sim/workOrders';
import { closureReasonsFor } from '../../src/core/sim/closureState';
import { companyUsesFormat7, formatVersionOf, layoutUsesFormat7 } from '../../src/core/io/project';
import { emptyLayout, must } from './helpers';
import { placeFacility, placeTerminalArea } from '../../src/core/layout/operations';

/**
 * 5-25 Work Order: 会社データ（任意項目）・保存形式 7 との連携・夜間枠での実施と
 * 資産の一時閉鎖・整備士プールの共有を検証する。SIM_MODEL_VERSION は 10.7 に上げた
 * （PO 承認 2026-11-19）ため、運航状態の復元条件が変わる。
 */
const NIGHT = 23 * 3600;
const NOON = 12 * 3600;

describe('Work Order の保存連携', () => {
  it('会社 JSON の往復で欠落しない（旧セーブ互換: 欠落 = 機能オフ）', () => {
    const c = createCareerCompany();
    const wo = addWorkOrder(c, { assetKind: 'stand', assetId: 'std_1', kind: 'inspection', engineers: 1, durationMin: 120, createdDay: 0 });
    const back = importCompany(JSON.stringify(c))!;
    expect(back.workOrders?.[wo.id]).toMatchObject({ assetId: 'std_1', kind: 'inspection', status: 'planned', progressMin: 0 });
    const plain = importCompany(JSON.stringify(createCareerCompany()))!;
    expect(plain.workOrders).toBeUndefined();
  });

  it('保存形式: Work Order を使う会社と動く歩道レイアウトは形式 7、それ以外は上げない', () => {
    const layout = createSampleAirport();
    const plain = createCareerCompany();
    expect(companyUsesFormat7(plain)).toBe(false);
    expect(formatVersionOf({ layout, company: plain, scenarios: [], sim: null })).toBeLessThan(7);
    const c = createCareerCompany();
    addWorkOrder(c, { assetKind: 'runway', assetId: 'rwy_1', kind: 'repair', engineers: 2, durationMin: 60, createdDay: 0 });
    expect(companyUsesFormat7(c)).toBe(true);
    expect(formatVersionOf({ layout, company: c, scenarios: [], sim: null })).toBe(7);

    let l = emptyLayout(120, 60);
    l = must(placeFacility(l, 'terminal', { x: 10, y: 10 }, { w: 12, h: 6 })).layout!;
    const termId = Object.values(l.facilities).find((f) => f.kind === 'terminal')!.id;
    expect(layoutUsesFormat7(l)).toBe(false);
    l = must(placeTerminalArea(l, termId, 0, 'movingWalkway', { x: 10, y: 10 }, { w: 4, h: 2 })).layout!;
    expect(layoutUsesFormat7(l)).toBe(true);
  });
});

describe('Work Order の実施（夜間枠・閉鎖・進捗）', () => {
  function setup(now: number) {
    const c = createCareerCompany();
    const sim = createSimulation(createSampleAirport(), { company: c, seed: 'wo-test' });
    sim.state.now = now;
    return { c, sim };
  }

  it('夜間枠の定義: 23:00〜05:00', () => {
    expect(isWorkOrderNight(NIGHT)).toBe(true);
    expect(isWorkOrderNight(4 * 3600)).toBe(true);
    expect(isWorkOrderNight(NOON)).toBe(false);
    expect(isWorkOrderNight(6 * 3600)).toBe(false);
  });

  it('夜間に開始し、対象スポットを理由付きで閉鎖、完了で解除する', () => {
    const { c, sim } = setup(NIGHT);
    const wo = addWorkOrder(c, { assetKind: 'stand', assetId: 'std_1', kind: 'inspection', engineers: 1, durationMin: 2, createdDay: 0 });
    stepWorkOrders(sim);
    expect(wo.status).toBe('active');
    expect(sim.state.closures.stands).toContain('std_1');
    expect(closureReasonsFor(sim.state, 'stands', 'std_1')).toContain(`workorder:${wo.id}`);
    for (let i = 0; i < 119; i++) stepWorkOrders(sim);
    expect(wo.status).toBe('done');
    expect(wo.progressMin).toBe(2);
    expect(sim.state.closures.stands).not.toContain('std_1');
  });

  it('昼間は開始しない。窓を出たら閉鎖は解けるが進捗と状態は保たれる', () => {
    const { c, sim } = setup(NOON);
    const wo = addWorkOrder(c, { assetKind: 'stand', assetId: 'std_1', kind: 'repair', engineers: 1, durationMin: 600, createdDay: 0 });
    stepWorkOrders(sim);
    expect(wo.status).toBe('planned');
    expect(sim.state.closures.stands).not.toContain('std_1');
    sim.state.now = NIGHT;
    stepWorkOrders(sim);
    expect(sim.state.closures.stands).toContain('std_1');
    const progressed = wo.progressMin;
    expect(progressed).toBeGreaterThan(0);
    sim.state.now = NOON + 86400;
    stepWorkOrders(sim);
    expect(wo.status).toBe('active');
    expect(wo.progressMin).toBe(progressed);
    expect(sim.state.closures.stands).not.toContain('std_1');
  });

  it('整備士が足りなければ実施しない（閉鎖も進捗もしない）', () => {
    const { c, sim } = setup(NIGHT);
    const wo = addWorkOrder(c, { assetKind: 'stand', assetId: 'std_1', kind: 'construction', engineers: 99, durationMin: 60, createdDay: 0 });
    stepWorkOrders(sim);
    expect(wo.progressMin).toBe(0);
    expect(sim.state.closures.stands).not.toContain('std_1');
  });

  it('滑走路は mode を閉鎖し、完了で元の mode に戻る', () => {
    const { c, sim } = setup(NIGHT);
    const runwayId = Object.keys(sim.state.runwayConfig)[0]!;
    const before = sim.state.runwayConfig[runwayId]!.mode;
    const wo = addWorkOrder(c, { assetKind: 'runway', assetId: runwayId, kind: 'inspection', engineers: 1, durationMin: 1, createdDay: 0 });
    stepWorkOrders(sim);
    expect(sim.state.runwayConfig[runwayId]!.mode).toBe('closed');
    for (let i = 0; i < 59; i++) stepWorkOrders(sim);
    expect(wo.status).toBe('done');
    expect(sim.state.runwayConfig[runwayId]!.mode).toBe(before);
  });
});
