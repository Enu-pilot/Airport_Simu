/**
 * 回帰（計画 1-15 / E-2 と 1-20 / TA-2）: 燃料施設・整備士・トーイングカー（・ハイドラントがないときの給油車）がない空港では、
 * 計画分析が GROUND_SUPPORT_MISSING（error）を返し、折り返し能力は 0 になる。operableTypes / canOperate は変えない（判定を重複させない）。
 */
import { describe, expect, it } from 'vitest';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { analyzeDayPlan, groundBlockers, planDay, turnaroundCapacity } from '../../../src/core/economy/planning';
import { deleteEntity, updateEntity } from '../../../src/core/layout/operations';
import type { AirportLayout } from '../../../src/core/model/types';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { createContext, operableTypes } from '../../../src/core/sim/context';
import { resolveType } from '../../../src/core/sim/aircraftTypes';
import { createSimulation, stepSimulation } from '../../../src/core/sim/simulation';
import { must } from '../helpers';

const analyze = (l: AirportLayout, seed = 's-ground') => {
  const company = createSandboxCompany(seed);
  const sim = createSimulation(l, { seed, company });
  const plan = planDay(company, 0, 1, sim.ctx.types);
  return { sim, plan, analysis: analyzeDayPlan(plan, sim.ctx) };
};
const errorsOf = (r: ReturnType<typeof analyze>) => r.analysis.issues.filter((x) => x.code === 'GROUND_SUPPORT_MISSING');
const withBase = (l: AirportLayout, props: Record<string, number>): AirportLayout => {
  const b = Object.values(l.facilities).find((f) => f.kind === 'gseBase')!;
  return must(updateEntity(l, b.id, { props: { ...b.props, ...props } })).layout;
};

describe('1-15 計画分析: 地上支援の不足', () => {
  it('サンプル空港: GROUND_SUPPORT_MISSING なし（回帰）', () => {
    const r = analyze(createSampleAirport());
    expect(r.plan.flights.length).toBeGreaterThan(0);
    expect(errorsOf(r)).toEqual([]);
  });

  it('燃料施設を撤去したサンプル空港: 計画分析にエラーが出る。運航すると出発 0 便（再現テスト）', () => {
    let l = createSampleAirport();
    for (const f of Object.values(l.facilities)) if (f.kind === 'fuelFarm') l = must(deleteEntity(l, f.id)).layout;
    const r = analyze(l, 'e-repro-fuel');
    for (let i = 0; i < 3 * 3600; i++) stepSimulation(r.sim);
    expect(r.plan.flights.length).toBeGreaterThan(0);
    const issues = errorsOf(r);
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.detail).toBe('燃料施設');
    expect(issues[0]!.keys.length).toBeGreaterThan(0);
    expect(r.sim.state.stats.departures).toBe(0);
    expect(turnaroundCapacity(r.sim.ctx)).toBe(0);
    // 重複判定をしない: 機種の運航可否は従来どおり
    expect(operableTypes(r.sim.ctx).length).toBeGreaterThan(0);
  }, 120_000);

  it('トーイングカー 0・整備士 0: それぞれ不足として列挙される（複数は ・ で連結）', () => {
    const base = createSampleAirport();
    const noTug = analyze(withBase(base, { tugs: 0 }));
    expect(errorsOf(noTug).map((i) => i.detail)).toEqual(['トーイングカー']);
    const m = Object.values(base.facilities).find((f) => f.kind === 'maintenance')!;
    const noEng = analyze(must(updateEntity(base, m.id, { props: { ...m.props, engineers: 0 } })).layout);
    expect(errorsOf(noEng).map((i) => i.detail)).toEqual(['整備士']);
    const both = withBase(must(updateEntity(base, m.id, { props: { ...m.props, engineers: 0 } })).layout, { tugs: 0 });
    expect(errorsOf(analyze(both)).map((i) => i.detail)).toEqual(['整備士・トーイングカー']);
  });

  it('給油車 0: ハイドラントにつながったスポットがなければエラー（ハイドラントがあればエラーなし）', () => {
    const l = withBase(createSampleAirport(), { fuelTrucks: 0 });
    const ctx = createContext(l);
    expect(ctx.hydrantStands.size).toBe(0);
    expect(groundBlockers(ctx, resolveType(ctx.types, 'narrow180'))).toEqual(['給油車']);
    const withHydrant = createContext(l);
    withHydrant.hydrantStands.add('std_1'); // 接続の作り方は fuelHydrants の別テストが担う。ここは判定条件だけ
    expect(groundBlockers(withHydrant, resolveType(withHydrant.types, 'narrow180'))).toEqual([]);
  });

  it('不足がない折り返しには出ない: groundBlockers は機種ごとに同じ結果を返す（決定的）', () => {
    const ctx = createContext(createSampleAirport());
    for (const id of ['narrow180', 'wide300']) expect(groundBlockers(ctx, resolveType(ctx.types, id))).toEqual([]);
  });
});

describe('1-20 折り返し能力に資源を反映', () => {
  it('トーイングカー 0・整備士 0・燃料施設なし: 0。サンプルは正の値', () => {
    const base = createSampleAirport();
    expect(turnaroundCapacity(createContext(base))).toBeGreaterThan(0);
    expect(turnaroundCapacity(createContext(withBase(base, { tugs: 0 })))).toBe(0);
    const m = Object.values(base.facilities).find((f) => f.kind === 'maintenance')!;
    expect(turnaroundCapacity(createContext(must(updateEntity(base, m.id, { props: { ...m.props, engineers: 0 } })).layout))).toBe(0);
    let l = base;
    for (const f of Object.values(l.facilities)) if (f.kind === 'fuelFarm') l = must(deleteEntity(l, f.id)).layout;
    expect(turnaroundCapacity(createContext(l))).toBe(0);
  });

  it('ハイドラントにつながったスポットがあれば、給油車 0 でも正の値（給油能力 = 給油車×2 + ハイドラント接続スポット数）', () => {
    const l = withBase(createSampleAirport(), { fuelTrucks: 0 });
    const ctx = createContext(l);
    expect(turnaroundCapacity(ctx)).toBe(0);
    ctx.hydrantStands.add('std_1');
    expect(turnaroundCapacity(ctx)).toBe(1);
    ctx.hydrantStands.add('std_2');
    expect(turnaroundCapacity(ctx)).toBe(2);
  });
});
