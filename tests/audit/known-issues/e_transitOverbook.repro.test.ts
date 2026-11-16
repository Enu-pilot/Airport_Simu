/**
 * 再現: バス・鉄道の時間あたり定員の超過が 6 時間先で「諦め」られ、定員を超えて受け入れられる。
 * 期待（docs/15_access_rules.md §3「出発旅客」3.: バス・鉄道は「その時間帯の定員（バス 50人 × 便数、列車 200人 × 本数）を超えたら、
 *   空きのある次の時間帯まで待つ」）: どの時間帯の乗車人数も 定員（50 × 便数）を超えない。
 * 実際: src/core/access/runtime.ts:195 の `while (h < hour + 6 && ...) h++` が 6 時間先で打ち切られ、その時間帯へ定員を無視して加算する
 *   （hourly['bus:16'] が 50 人/時を超える）。実害は極端な過負荷時のみ（便数 1/時で 6 時間分超の出発旅客が同一時間帯に来る場合）。
 * 実行: AUDIT_KNOWN=1 npx vitest run -c vitest.audit.config.ts tests/audit/known-issues/e_transitOverbook
 */
import { describe, expect, it } from 'vitest';
import { accessDeparture } from '../../../src/core/access/runtime';
import { BALANCE } from '../../../src/core/economy/balance';
import type { PaxGroup } from '../../../src/core/sim/types';
import { accessLayout, mkSim } from '../e_helpers';

describe('e-repro transit overbook beyond 6h', () => {
  it('1 便/時のバス（定員 50人/時）に 500 人分（10 時間分）が着くと、どの時間帯も 50 人を超えない（期待）', () => {
    const sim = mkSim(accessLayout({ bus: { busBays: 1, busesPerHour: 1 } }), 'e-repro-overbook');
    const acc = sim.state.access!;
    for (const m of Object.keys(acc.shares) as (keyof typeof acc.shares)[]) acc.shares[m] = m === 'bus' ? 1 : 0;
    acc.available = ['bus'];
    sim.state.now = 10 * 3600;
    for (let i = 0; i < 100; i++) accessDeparture(sim, { id: `g${i}`, count: 5, walkSec: 0, waitSec: 0, state: 'toAirport' } as unknown as PaxGroup);
    const hours = Object.entries(acc.hourly).filter(([k]) => k.startsWith('bus:'));
    const peak = Math.max(...hours.map(([, v]) => v));
    console.log(`[audit-e] repro-overbook ${JSON.stringify({ capPaxPerH: BALANCE.accessModel.busSeats, peakHourPax: peak, hours })}`);
    expect(peak).toBeLessThanOrEqual(BALANCE.accessModel.busSeats);
  });
});
