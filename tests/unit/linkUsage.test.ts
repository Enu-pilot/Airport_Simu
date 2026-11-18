import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import { addContract, createCompany } from '../../src/core/economy/company';
import { DAY_SEC } from '../../src/core/sim/rules';
import { takeLinkUsage } from '../../src/core/sim/linkUsage';

/**
 * 5-03: 連絡設備・上下移動設備の利用実績。
 * サンプル空港の出発旅客は 1F のチェックインへ行くためにエスカレーター（ta_5）を必ず通る。
 * 1 日運航すると時間帯別の利用人数が積まれ、締め処理で日報に移って記録が消えることを確認する。
 */
describe('リンク利用実績（5-03）', () => {
  it('エスカレーターの利用人数が時間帯別に記録され、日報に移る', { timeout: 300_000 }, () => {
    const company = createCompany('career', 'link-usage');
    addContract(company, { airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 4, feeDiscount: 0, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, window: 'any' });
    const sim = createSimulation(createSampleAirport(), { company });
    const target = (Math.floor(sim.state.now / DAY_SEC) + 1) * DAY_SEC;
    while (sim.state.now <= target) stepSimulation(sim);

    const report = company.reports[company.reports.length - 1]!;
    expect(report).toBeDefined();
    const usage = report.linkUsage ?? [];
    const escalator = usage.find((u) => u.linkId === 'vertical:ta_5');
    expect(escalator).toBeDefined();
    expect(escalator!.kind).toBe('vertical');
    expect(escalator!.total).toBeGreaterThan(0);
    expect(escalator!.hourly.reduce((a, b) => a + b, 0)).toBe(escalator!.total);
    expect(escalator!.peakCount).toBe(Math.max(...escalator!.hourly));
    expect(escalator!.capacityPerHour).toBe(2400); // エスカレーターの既定能力
    // 締めで読み取ったので、記録は消えている（保存・フィンガープリント対象外の保持なので WeakMap で確認する）
    expect(takeLinkUsage(sim.state)).toBeUndefined();
  });
});
