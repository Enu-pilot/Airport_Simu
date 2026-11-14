import { describe, expect, it } from 'vitest';
import { addContract, createCareerCompany } from '../../src/core/economy/company';
import { analyzeAirportCapacity, previewContractCapacity } from '../../src/core/economy/capacity';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { createContext } from '../../src/core/sim/context';
import { RUNWAY_HOURLY_CAPACITY } from '../../src/core/economy/planning';
import type { AirportLayout } from '../../src/core/model/types';

const onlyArea = (layout: AirportLayout, kind: string) => Object.values(layout.terminalAreas).find((a) => a.kind === kind)!;

describe('空港能力分析', () => {
  it('計画需要と既存の運航計画能力から時間・日次サマリーを作る', () => {
    const layout = createStarterAirfield();
    const company = createCareerCompany();
    const result = analyzeAirportCapacity(company, createContext(layout));
    const runways = Object.values(layout.runways).filter((r) => r.buildState === 'operational').length;
    expect(result.summary.find((m) => m.name === '滑走路')?.capacity).toBe(runways * RUNWAY_HOURLY_CAPACITY);
    expect(result.summary.find((m) => m.name === '滑走路')?.demand).toBe(Math.max(...result.analysis.hourly.movements));
    expect(result.summary.find((m) => m.name === '1日総処理（滑走路・理論値）')?.capacity).toBe(runways * RUNWAY_HOURLY_CAPACITY * result.operatingHours);
    expect(result.peakHour.movements).toBe(Math.max(...result.analysis.hourly.movements));
  });

  it('レーン数の変更で能力・不足判定が変わる', () => {
    const layout = createStarterAirfield();
    const company = createCareerCompany();
    const full = analyzeAirportCapacity(company, createContext(layout));
    const lowLayout = structuredClone(layout);
    onlyArea(lowLayout, 'security').props.lanes = 0;
    const low = analyzeAirportCapacity(company, createContext(lowLayout));
    expect(low.summary.find((m) => m.name === '保安検査')?.capacity).toBe(0);
    expect(low.summary.find((m) => m.name === '保安検査')?.capacity).toBeLessThan(full.summary.find((m) => m.name === '保安検査')?.capacity ?? 0);
    if ((low.summary.find((m) => m.name === '保安検査')?.demand ?? 0) > 0) expect(low.summary.find((m) => m.name === '保安検査')?.status).toBe('shortage');
  });

  it('能力モデルがない工程は未算出とし、仮想契約チェックで会社状態を変更しない', () => {
    const layout = createStarterAirfield();
    const company = createCareerCompany();
    const before = JSON.stringify(company);
    const result = analyzeAirportCapacity(company, createContext(layout));
    expect(result.summary.find((m) => m.name === '誘導路')?.capacity).toBeNull();
    expect(result.summary.find((m) => m.name === '搭乗バス')?.capacity).toBeNull();
    const preview = previewContractCapacity(company, createContext(layout), { airlineId: 'AQ', destinationId: 'KTA', typeId: 'narrow180', perDay: 2, window: 'morning' });
    expect(preview.after.plan.flights.length).toBeGreaterThan(preview.before.plan.flights.length);
    expect(JSON.stringify(company)).toBe(before);
  });

  it('ターミナル収容モデルと運航中の未完了旅客人数を区別して表示する', () => {
    const layout = createStarterAirfield();
    const company = createCareerCompany();
    const ctx = createContext(layout);
    const terminalId = Object.keys(ctx.terminal.byTerminal)[0]!;
    const people = analyzeAirportCapacity(company, ctx, [], undefined, { [terminalId]: 17 });
    const metric = people.summary.find((m) => m.name === 'ターミナル最大収容人数')!;
    expect(metric.capacity).toBeGreaterThan(17);
    expect(metric.demand).toBe(17);
  });

  it('新しい契約需要に合わせて時間帯別ピークとスポット利用数を変える', () => {
    const layout = createStarterAirfield();
    const company = createCareerCompany();
    const before = analyzeAirportCapacity(company, createContext(layout));
    addContract(company, { airlineId: 'AQ', destinationId: 'KTA', typeId: 'narrow180', perDay: 3, window: 'morning', feeDiscount: 0, startDay: company.day, endDay: company.day, status: 'active', offerExpiresDay: company.day });
    const after = analyzeAirportCapacity(company, createContext(layout));
    expect(after.plan.flights.length).toBeGreaterThan(before.plan.flights.length);
    expect(after.summary.find((m) => m.name === 'スポット同時駐機')?.demand).toBeGreaterThanOrEqual(before.summary.find((m) => m.name === 'スポット同時駐機')?.demand ?? 0);
  });
});
