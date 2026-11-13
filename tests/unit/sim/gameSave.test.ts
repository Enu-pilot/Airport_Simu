import { describe, expect, it } from 'vitest';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { defaultGame } from '../../../src/core/economy/game';
import { initialGoals } from '../../../src/core/economy/goals';
import { buildProject, effectiveModels, restoreSimulation, serializeProject, validateProject } from '../../../src/core/io/project';
import { stepTicks } from '../../../src/core/sim/dayloop';
import { checkInvariants } from '../../../src/core/sim/invariants';
import { createSimulation, stepSimulation } from '../../../src/core/sim/simulation';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';

/** 12B-3a B3/B5/B6: 天候 5 段階・評価・目標を含む保存・復元と、日のループの分割実行の一致 */
type D = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const NOW = '2026-11-13T00:00:00Z';
const opts = { fallbackCompany: createSandboxCompany() };

function make() {
  const c = createSandboxCompany();
  c.day = 108;
  c.game = defaultGame();
  c.airlineEval = {};
  c.goals = initialGoals();
  return createSimulation(createSampleAirport(), { seed: 'save-wx', company: c });
}
const project = (sim: ReturnType<typeof make>) => buildProject({ name: 'g', savedAt: NOW, layout: sim.ctx.layout, company: createSandboxCompany(), pin: null, scenarios: [], sim });

describe('ゲームのモデルの保存', () => {
  it('悪天の運航中に保存 → 読み込み → 継続が、中断しなかった場合とビット単位で一致する（formatVersion 2）', { timeout: 600_000 }, () => {
    const a = make();
    stepTicks(a, 8 * 3600);
    expect(a.state.wx!.level).toBeGreaterThan(1);
    const p = project(a);
    expect(p.formatVersion).toBe(2);
    expect(p.company.game).toBeDefined();
    const r = validateProject(serializeProject(p), opts);
    expect(r.errors).toEqual([]);
    const { sim: b, violations } = restoreSimulation(r.project!.layout, r.project!.sim!, effectiveModels(r.project!.catalog));
    expect(violations).toEqual([]);
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
    expect(b.company).toEqual(a.company);
    for (let i = 0; i < 3600; i++) {
      stepSimulation(a);
      stepSimulation(b);
      if (i % 600 === 0) expect(checkInvariants(b)).toEqual([]);
    }
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
  });

  it('分割実行の一致: game ありでも、1 回で進めても細切れに進めても結果が同じ', { timeout: 600_000 }, () => {
    const a = make();
    const b = make();
    stepTicks(a, 4 * 3600);
    for (let i = 0; i < 48; i++) stepTicks(b, 300);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it('wx・airlineEval・goals・game の形が不正なファイルは読み込まない', { timeout: 300_000 }, () => {
    const a = make();
    stepTicks(a, 600);
    const good = JSON.parse(serializeProject(project(a)));
    const bad = (mutate: (d: D) => void, re: RegExp) => {
      const d = structuredClone(good);
      mutate(d);
      const r = validateProject(JSON.stringify(d), opts);
      expect(r.ok, String(re)).toBe(false);
      expect(r.errors.join('\n')).toMatch(re);
    };
    bad((d) => (d.sim.state.wx.hours = d.sim.state.wx.hours.slice(0, 5)), /wx\.hours/);
    bad((d) => (d.sim.state.wx.level = 9), /wx\.level/);
    bad((d) => (d.sim.state.wx.rng = [1]), /wx\.rng/);
    bad((d) => delete d.sim.state.wx, /wx）がありません/);
    bad((d) => (d.sim.company.game.weather = 'legacy'), /wx）があるのに/);
    bad((d) => (d.company.game.difficulty = 'easy'), /難易度/);
    bad((d) => (d.company.goals.tier = 7), /tier/);
    bad((d) => (d.company.goals.done = { nope: 1 }), /done/);
    bad((d) => (d.company.airlineEval = { SK: { ema: { otp: 500 } } }), /ema|形が不正/);
    bad((d) => (d.company.airlineEval = { XX: {} }), /航空会社が不明/);
  });
});
