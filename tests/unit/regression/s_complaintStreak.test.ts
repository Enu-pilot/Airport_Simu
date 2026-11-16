/**
 * 回帰（計画 1-21 S-4）: 不満は「移動平均が 45 未満の締めが 2 回『続く』と発生」（docs/30 §評価）。
 * 旧: 45〜55 の帯では low[k] が戻らず、<45 → 帯 → <45 の連続でない 2 回でも不満が発生した（解消は 55 以上のまま = ヒステリシス）。
 * 新: 帯の中の締めで連続回数を 0 に戻す。すでにある不満は帯の間は維持する（解消は 55 以上）。
 */
import { describe, expect, it } from 'vitest';
import { COMPLAINT_DAYS, COMPLAINT_OFF, COMPLAINT_ON, EMA_ALPHA, stepAirlineEval } from '../../../src/core/economy/airlineEval';
import type { AirlineScore, ScoreComponent } from '../../../src/core/economy/airlineScore';
import { createCareerCompany, type CompanyState } from '../../../src/core/economy/company';

const AIRLINE = 'AQ';
const score = (otp: number): AirlineScore => ({
  airlineId: AIRLINE,
  active: true,
  satisfaction: 60,
  components: [{ key: 'otp', level: 'good', score: otp, facts: {} } as ScoreComponent],
  lacking: [],
});
/** otp の移動平均が target になるように点数を逆算する */
const scoreFor = (company: CompanyState, target: number): number => {
  const ema = company.airlineEval?.[AIRLINE]?.ema.otp ?? 60;
  return (target - (1 - EMA_ALPHA) * ema) / EMA_ALPHA;
};
function step(c: CompanyState, target: number): void {
  const s = Math.max(0, Math.min(100, scoreFor(c, target)));
  stepAirlineEval(c, { scores: [score(s)], operable: new Set() });
  c.day++;
}
const entry = (c: CompanyState) => c.airlineEval![AIRLINE]!;

describe('1-21 S-4 不満の連続日数', () => {
  it('前提の定数', () => {
    expect([COMPLAINT_ON, COMPLAINT_OFF, COMPLAINT_DAYS]).toEqual([45, 55, 2]);
  });

  it('45 未満が 2 回続くと不満が発生する（従来どおり）', () => {
    const c = createCareerCompany();
    step(c, 40);
    expect(entry(c).complaints).toHaveLength(0);
    expect(entry(c).low.otp).toBe(1);
    step(c, 40);
    expect(entry(c).complaints.map((x) => x.key)).toEqual(['otp']);
  });

  it('<45 → 帯（45〜55）→ <45 は連続でないので不満にならない（再現テスト）', () => {
    const c = createCareerCompany();
    step(c, 40);
    expect(entry(c).low.otp).toBe(1);
    step(c, 50); // 帯の中
    expect(entry(c).ema.otp).toBeCloseTo(50, 1);
    expect(entry(c).low.otp).toBe(0);
    step(c, 40);
    expect(entry(c).complaints).toHaveLength(0);
    expect(entry(c).low.otp).toBe(1);
  });

  it('すでにある不満は、帯の間は維持し（ヒステリシス）、55 以上で解消する', () => {
    const c = createCareerCompany();
    step(c, 40);
    step(c, 40);
    expect(entry(c).complaints).toHaveLength(1);
    step(c, 50);
    expect(entry(c).complaints).toHaveLength(1); // 帯: 維持
    step(c, 56);
    expect(entry(c).complaints).toHaveLength(0); // 解消
  });

  it('境界: ちょうど 45 は不満の水準ではない（帯）、ちょうど 55 は解消', () => {
    const c = createCareerCompany();
    step(c, 40);
    step(c, 45);
    expect(entry(c).low.otp).toBe(0);
    const d = createCareerCompany();
    step(d, 40);
    step(d, 40);
    step(d, 55);
    expect(entry(d).complaints).toHaveLength(0);
  });
});
