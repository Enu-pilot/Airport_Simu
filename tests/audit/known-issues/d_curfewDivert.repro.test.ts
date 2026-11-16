/**
 * 既知の不具合の再現（監査 d / 夜間騒音規制）: 夜間規制で待機した到着機が 2 機以上いると、先頭 1 機だけが 06:00 に着陸し、残りは同じ tick（05:58:30）にまとめてダイバートされる。
 *
 * 期待（docs/31_city_models.md「遅延で夜間にかかった着陸は次の06:00まで待機する」。simulation.ts:1100 は noiseCurfew を空中待機 45 分の上限から除外している＝夜間規制の待機で運航不能にしない設計）:
 *   規制で待った機体は規制解除後に通常の順番待ち（間隔 75〜90 秒）で順に着陸する。解除後の待ちは 45 分（HOLD_DIVERT_SEC）に遠く及ばない。
 * 実際: 3 機とも 22:00 台の規制で待機（waitSince = 22:13 頃）→ 05:58:30 に先頭機だけが進入許可を得て、残りは holdReason が 'separation' に変わった時点で
 *   `state.now - ac.waitSince >= HOLD_DIVERT_SEC`（waitSince は規制待機の開始時刻のまま 7 時間以上前）が真になり、即座にダイバート（出発便は欠航・補償）。
 * 原因: setHold（simulation.ts:231-240）は reason が変わっても waitSince を更新せず（`??=`）、stepInbound の除外条件（:1100）は「今の holdReason が noiseCurfew でないとき」だけを見る。
 * コード: src/core/sim/simulation.ts:1052-1060（夜間待機に入る）, :1100-1102（ダイバート判定）, :231-240（setHold）。
 * 実行: AUDIT_KNOWN=1 npx vitest run -c vitest.audit.config.ts tests/audit/known-issues/d_curfewDivert.repro.test.ts
 */
import { expect, it } from 'vitest';
import { addTurnaround, stepSimulation } from '../../../src/core/sim/simulation';
import { cityCompany, citySim, DAY_SEC, H, hms, isNight, linearLayout } from '../d_helpers';

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
