/**
 * 回帰（計画 1-12 / 監査 d / D-1）: 夜間規制で待機した到着機は、規制解除後に通常の順番待ちで順に着陸する（ダイバートしない）。
 * 旧: 待機の理由が変わっても waitSince が規制待機の開始時刻のままで、規制明けの最初の tick で 45 分の上限を超えたと見なされダイバートした。
 * 修正: noiseCurfew から別の理由に変わったとき waitSince を取り直す（夜間待機の時間は上限に数えない）。上限そのものは維持する。
 */
import { describe, expect, it } from 'vitest';
import { addTurnaround, stepSimulation } from '../../../src/core/sim/simulation';
import { HOLD_DIVERT_SEC } from '../../../src/core/sim/rules';
import { cityCompany, citySim, DAY_SEC, H, hms, isNight, linearLayout } from '../../audit/d_helpers';

describe('1-12 夜間待機 → ダイバート', () => {
  it('夜間規制で待機した 3 機は、06:00 以降に順番に着陸する（ダイバートされない）。seed=d2-divert', () => {
    const c = cityCompany('d2-divert', 'core');
    const sim = citySim(linearLayout({ stands: 4 }), c, { seed: 'd2-divert', startTime: 21 * H });
    const acs = [0, 1, 2].map((i) => addTurnaround(sim, 'narrow180', 21 * H + 40 * 60 + i * 60, { inboundDelaySec: 40 * 60, departureAt: 23 * H + i * 600 }));
    for (let i = 0; i < 12 * H; i++) {
      stepSimulation(sim);
      if (sim.state.now > DAY_SEC + 7 * H && acs.every((a) => ['departed', 'diverted'].includes(a.state))) break;
    }
    const landed = acs.map((a) => sim.state.flights[a.arrivalFlightId]!.actual);
    const detail = acs.map((a, i) => `${a.id}:${a.state}@${hms(a.stateSince)} landed=${landed[i] === null ? 'none' : hms(landed[i]!)}`);
    expect(sim.state.stats.diverted, detail.join(' | ')).toBe(0);
    for (const t of landed) {
      expect(t).not.toBeNull();
      expect(t!).toBeGreaterThanOrEqual(DAY_SEC + 6 * H);
      expect(isNight(t!)).toBe(false);
    }
  });

  it('夜間待機のあと、通常の待機（スポット待ち）が 45 分を超えたらダイバートする（上限は生きている）', () => {
    // スポット 1 つ。先着機 A は 06:00 以降の出発まで居座るので、後続機 B は規制明けに noStand で待つ。
    const c = cityCompany('s-curfew-cap', 'core');
    const sim = citySim(linearLayout({ stands: 1 }), c, { seed: 's-curfew-cap', startTime: 21 * H });
    const a = addTurnaround(sim, 'narrow180', 21 * H + 40 * 60, { inboundDelaySec: 40 * 60, departureAt: DAY_SEC + 12 * H });
    const b = addTurnaround(sim, 'narrow180', 21 * H + 50 * 60, { inboundDelaySec: 40 * 60, departureAt: DAY_SEC + 13 * H });
    let curfewHoldSeen = false;
    let divertedAt: number | null = null;
    let holdStart: number | null = null;
    for (let i = 0; i < 14 * H && divertedAt === null; i++) {
      stepSimulation(sim);
      if (b.holdReason === 'noiseCurfew') curfewHoldSeen = true;
      if (curfewHoldSeen && holdStart === null && b.holdReason && b.holdReason !== 'noiseCurfew') {
        holdStart = sim.state.now;
        expect(Math.abs(b.waitSince! - sim.state.now)).toBeLessThanOrEqual(1); // tick 内の更新順で 1 秒ずれ得る。 待機アラートの待ち分数は規制明けから数える
      }
      if (b.state === 'diverted') divertedAt = sim.state.now;
    }
    expect(a.state).not.toBe('diverted');
    expect(curfewHoldSeen).toBe(true);
    expect(holdStart).not.toBeNull();
    expect(holdStart!).toBeGreaterThanOrEqual(DAY_SEC + 6 * H - 120); // 夜間待機は 06:00 まで
    expect(divertedAt).not.toBeNull();
    // 規制明けの通常待機から数えて 45 分（再試行間隔ぶんの誤差のみ）で上限に達する
    expect(divertedAt! - holdStart!).toBeGreaterThanOrEqual(HOLD_DIVERT_SEC);
    expect(divertedAt! - holdStart!).toBeLessThan(HOLD_DIVERT_SEC + 600);
  });
});
