/**
 * 再現: 代替スポットへの変更（reassignStand）が {ok: true} を返すのに、すでにスポットを割り当て済みの進入機では効かない。
 * 期待（docs/19_disruptions.md:39 プレイヤーの対応「代替スポットへの変更」、src/core/sim/disruptions.ts:324,339 のコメント
 *   「着陸前の到着機のみ … 計画スポットを変更して、次の割り当てで使わせる」）: 変更先のスポットに駐機する。
 *   これは複数ターミナルの旅客移動（docs/35）の唯一の起点でもある。
 * 実際: 進入機は最初の割当でホームスポット（docs/32 §1: 航空会社ごとの優先リスト）に登録済み。再割当では src/core/sim/simulation.ts:608-612 の
 *   並び替えでホームスポットが「計画スポット」(simulation.ts:612 homeSet.size === 0 のときだけ有効) より前に評価され、元のスポットに戻る。
 *   着陸前（state = 'scheduled'）で割当前なら変更できる（tests/audit/b_levelLinks はこの場合のみ）。
 * 実行: AUDIT_KNOWN=1 npx vitest run -c vitest.audit.config.ts tests/audit/known-issues/e_reassignHome
 */
import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { reassignStand } from '../../../src/core/sim/disruptions';
import { SIM_START_SEC as T0 } from '../../../src/core/sim/rules';
import { addTurnaround, createSimulation, stepSimulation } from '../../../src/core/sim/simulation';

describe('e-repro reassignStand と航空会社ホームスポット', () => {
  it('スポット割当済みの進入機を std_5 に変更すると、10 分後に std_5 に割り当てられている（期待）', () => {
    const sim = createSimulation(createSampleAirport(), { seed: 'e-repro-reassign', settings: { autoSchedule: false, inboundDelayProb: 0 } });
    const ac = addTurnaround(sim, 'narrow180', T0 + 3600, { departureAt: T0 + 3 * 3600, plan: { contractId: 'e', destinationId: 'north', arrPax: 100, depPax: 100, standId: 'std_1', seats: 180 } });
    for (let k = 0; k < 20000 && !(ac.state === 'inbound' && ac.standId); k++) stepSimulation(sim);
    const before = ac.standId;
    const r = reassignStand(sim, ac.id, 'std_5');
    for (let i = 0; i < 600; i++) stepSimulation(sim);
    console.log(`[audit-e] repro-reassign ${JSON.stringify({ result: r, before, after: ac.standId, homes: sim.state.airlineStandHomes?.byAirline })}`);
    expect(r).toEqual({ ok: true });
    expect(ac.standId).toBe('std_5');
  });
});
