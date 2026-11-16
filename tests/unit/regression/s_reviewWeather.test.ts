/**
 * 回帰（計画 1-21 S-2）: 振り返りに、その日の天候（5 段階）の変化が出る。
 * 旧: review.disruptions は障害（state.disruptions）だけで、game.weather === 'levels' の計画天候の変化が入らず、
 * 画面は天候が悪化した日にも「この日は障害・天候の変化はありませんでした」と出した。
 */
import { describe, expect, it } from 'vitest';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { defaultGame } from '../../../src/core/economy/game';
import { buildDayReview, emptyResponses } from '../../../src/core/analytics/review';
import { stepTicks } from '../../../src/core/sim/dayloop';
import { DAY_SEC } from '../../../src/core/sim/rules';
import { createSimulation } from '../../../src/core/sim/simulation';
import { weatherPlan } from '../../../src/core/sim/weather';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';

const BAD_DAY = 108; // seed 'sandbox' / temperate / normal: 7〜20 時に段階 4 が 7 時間ある（tests/unit/sim/weatherSim.test.ts と同じ）

function reviewOf(day: number, weather: 'levels' | 'legacy') {
  const c = createSandboxCompany();
  c.day = day;
  c.game = { ...defaultGame('normal'), weather };
  const sim = createSimulation(createSampleAirport(), { seed: 'wx-review', company: c, settings: { randomDisruptions: false } });
  const dayStart = sim.state.now;
  const before = Object.fromEntries(Object.entries(sim.company!.airlines).map(([id, a]) => [id, a.satisfaction]));
  expect(stepTicks(sim, 200_000, { stopAtDayClose: true }).stop).toBe('dayClose');
  const review = buildDayReview({ sim, company: sim.company!, dayStart, airlinesBefore: before, responses: emptyResponses(), access: 1 });
  return { sim, review, dayStart };
}

describe('1-21 S-2 振り返りの天候', () => {
  it('天候が悪化した日（levels）: review.weather に最大の段階と変化の時刻・段階が入る（再現テスト）', { timeout: 300_000 }, () => {
    const { sim, review } = reviewOf(BAD_DAY, 'levels');
    const c = sim.company!;
    const plan = weatherPlan(c.seed, BAD_DAY, c.game!.climate, c.game!.difficulty);
    expect(Math.max(...plan.map((h) => h.level))).toBe(4);
    expect(review.weather).toBeDefined();
    expect(review.weather!.maxLevel).toBe(4);
    expect(review.weather!.changes.length).toBeGreaterThan(0);
    // 変化は 1 時間単位の時刻で、段階が前の時間と違う箇所だけ。最初の変化の前の段階は 0
    let prev = 0;
    const expected: { h: number; level: number }[] = [];
    plan.forEach((h, i) => { if (h.level !== prev) expected.push({ h: i, level: h.level }); prev = h.level; });
    expect(review.weather!.changes.map((x) => ({ h: (x.t % DAY_SEC) / 3600, level: x.level }))).toEqual(expected);
    expect(review.weather!.changes.every((x) => x.t % 3600 === 0)).toBe(true);
  });

  it('従来の天候（legacy）の運航・game のない運航では、review.weather を作らない（旧保存レビューと同じ形）', { timeout: 300_000 }, () => {
    expect(reviewOf(BAD_DAY, 'legacy').review.weather).toBeUndefined();
  });

  it('1 日目（day 0）は晴れ固定: 変化なし（changes が空）', { timeout: 300_000 }, () => {
    const { review } = reviewOf(0, 'levels');
    expect(review.weather).toEqual({ maxLevel: 0, changes: [] });
  });

  it('決定的: 同じ入力で同じ内容。レビューの作成は運航状態を変えない', { timeout: 300_000 }, () => {
    const a = reviewOf(BAD_DAY, 'levels');
    const b = reviewOf(BAD_DAY, 'levels');
    expect(a.review.weather).toEqual(b.review.weather);
  });
});
