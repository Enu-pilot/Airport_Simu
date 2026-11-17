import { describe, expect, it } from 'vitest';
import { createSandboxCompany } from '../../src/core/economy/company';
import { defaultCity, defaultCityNightOps } from '../../src/core/economy/city';
import { buildProject, serializeProject, validateProject } from '../../src/core/io/project';
import { updateLayoutSettings } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createContext } from '../../src/core/sim/context';
import { stepTicks } from '../../src/core/sim/dayloop';
import { createSimulation } from '../../src/core/sim/simulation';
import { must } from './helpers';

/** T9: 運航状態の taxiBlocks・便の nightHold の保存と検証（plan §1.4・2-10 のうち形・参照の検査。往復の継続は tests/unit/sim 側） */
type D = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const NOW = '2026-11-17T00:00:00Z';
const opts = { fallbackCompany: createSandboxCompany() };
const stats = { resolutions: 0, reroutes: 0, overruns: 0, unresolved: 0, nightStranded: 0 };

function makeSim(block: boolean, night: boolean) {
  const c = createSandboxCompany('p2-state');
  c.city = defaultCity('core');
  if (night) c.city.nightOps = defaultCityNightOps();
  let layout = createSampleAirport();
  if (block) layout = must(updateLayoutSettings(layout, { taxiMode: 'block' })).layout;
  const sim = createSimulation(layout, { seed: 'p2-state', company: c });
  stepTicks(sim, 3 * 3600);
  return sim;
}
const projectOf = (sim: ReturnType<typeof makeSim>) =>
  buildProject({ name: 'p', savedAt: NOW, layout: sim.ctx.layout, company: createSandboxCompany(), pin: null, scenarios: [], sim });
const activeAircraft = (d: D): string => Object.values(d.sim.state.aircraft as Record<string, D>).find((a) => !['departed', 'diverted', 'cannotOperate'].includes(a.state))!.id;
const doneAircraft = (d: D): string | undefined => Object.values(d.sim.state.aircraft as Record<string, D>).find((a) => ['departed', 'diverted', 'cannotOperate'].includes(a.state))?.id;

describe('taxiBlocks の検証（block のレイアウト）', () => {
  const sim = makeSim(true, true);
  const base = JSON.parse(serializeProject(projectOf(sim))) as D;
  const withTaxi = (mutate: (tb: D, d: D) => void): D => {
    const d = structuredClone(base);
    const blockId = Object.keys(createContext(d.layout).blocks!.blocks)[0]!;
    const corridorId = Object.keys(createContext(d.layout).blocks!.corridors)[0]!;
    d.sim.state.taxiBlocks = { occ: {}, locks: {}, stats: { ...stats } };
    mutate(d.sim.state.taxiBlocks, { ...d, blockId, corridorId, ac: activeAircraft(d) });
    return d;
  };
  const errorsOf = (d: D) => validateProject(JSON.stringify(d), opts).errors.join('\n');

  it('版 4 の項目だけが入ったファイルは版 4。空の taxiBlocks は形として有効', () => {
    expect(base.formatVersion).toBe(4);
    const d = withTaxi(() => undefined);
    d.formatVersion = 4;
    expect(errorsOf(d)).toBe('');
  });

  it('異常: 存在しない区間 ID・回廊 ID・存在しない機体・向き・保持者の重複・統計の型は読み込みエラー', () => {
    const cases: [string, (tb: D, c: D) => void, RegExp][] = [
      ['区間 ID', (tb, c) => { tb.occ['nope#9'] = [c.ac]; }, /存在しない区間/],
      ['占有の機体', (tb, c) => { tb.occ[c.blockId] = ['ghost']; }, /存在しない・終了した機体/],
      ['占有が空', (tb, c) => { tb.occ[c.blockId] = []; }, /占有の形/],
      ['占有の重複', (tb, c) => { tb.occ[c.blockId] = [c.ac, c.ac]; }, /占有の形/],
      ['回廊 ID', (tb, c) => { tb.locks['nope'] = { dir: 1, holders: [c.ac] }; }, /存在しない回廊/],
      ['向き', (tb, c) => { tb.locks[c.corridorId] = { dir: 2, holders: [c.ac] }; }, /向き・保持者/],
      ['保持者が空', (tb, c) => { tb.locks[c.corridorId] = { dir: 1, holders: [] }; }, /向き・保持者/],
      ['保持者の重複', (tb, c) => { tb.locks[c.corridorId] = { dir: -1, holders: [c.ac, c.ac] }; }, /向き・保持者/],
      ['保持者の機体', (tb, c) => { tb.locks[c.corridorId] = { dir: 1, holders: ['ghost'] }; }, /存在しない・終了した機体/],
      ['oppWait', (tb) => { tb.oppWait = { nope: { acId: 'x', since: 1 } }; }, /対向待ち/],
      ['priority', (tb) => { tb.priority = 'ghost'; }, /priority/],
      ['priorityAt 単独', (tb) => { tb.priorityAt = 5; }, /priorityAt/],
      ['統計の型', (tb) => { tb.stats.unresolved = -1; }, /統計 unresolved/],
      ['統計の小数', (tb) => { tb.stats.reroutes = 1.5; }, /統計 reroutes/],
      ['形', (tb) => { tb.locks = []; }, /形が不正/],
    ];
    for (const [name, mutate, re] of cases) {
      const e = errorsOf(withTaxi(mutate));
      expect(e, name).toMatch(re);
    }
  });

  it('異常: 終了状態の機体を占有・保持者に持つファイルは読み込みエラー', () => {
    const d = withTaxi(() => undefined);
    const done = doneAircraft(d);
    if (done === undefined) return; // 3 時間で終了機がない配置では対象なし
    d.sim.state.taxiBlocks.occ[Object.keys(createContext(d.layout).blocks!.blocks)[0]!] = [done];
    expect(errorsOf(d)).toMatch(/存在しない・終了した機体/);
  });

  it('従来方式（taxiMode なし）のレイアウトに taxiBlocks があるファイルは読み込みエラー', () => {
    const legacy = JSON.parse(serializeProject(projectOf(makeSim(false, false)))) as D;
    legacy.sim.state.taxiBlocks = { occ: {}, locks: {}, stats: { ...stats } };
    legacy.formatVersion = 4;
    legacy.versions.format = 4;
    expect(errorsOf(legacy)).toMatch(/taxiMode/);
  });

  it('版 3 以下を名乗るのに taxiBlocks があるファイルは読み込みエラー', () => {
    const d = withTaxi(() => undefined);
    d.formatVersion = 3;
    d.versions.format = 3;
    expect(errorsOf(d)).toMatch(/版 4/);
  });
});

describe('nightHold の検証', () => {
  const sim = makeSim(false, true);
  const base = JSON.parse(serializeProject(projectOf(sim))) as D;
  const firstFlight = (d: D): D => Object.values(d.sim.state.flights as Record<string, D>)[0]!;
  const errorsOf = (d: D) => validateProject(JSON.stringify(d), opts).errors.join('\n');
  it('正しい nightHold は版 4 で往復できる。値は保たれる', () => {
    const d = structuredClone(base);
    const f = firstFlight(d);
    f.nightHold = { kind: 'stand', decidedAt: 1000, releaseAt: 2000 };
    d.formatVersion = 4;
    const r = validateProject(JSON.stringify(d), opts);
    expect(r.errors).toEqual([]);
    expect(r.project!.formatVersion).toBe(4);
    expect(r.project!.sim!.state.flights[f.id]!.nightHold).toEqual({ kind: 'stand', decidedAt: 1000, releaseAt: 2000 });
  });
  it('異常: 種類・時刻の不正、releaseAt < decidedAt、nightOps のない会社は読み込みエラー', () => {
    for (const bad of [{ kind: 'x', decidedAt: 1, releaseAt: 2 }, { kind: 'origin', decidedAt: 'a', releaseAt: 2 }, { kind: 'airborne', decidedAt: 5, releaseAt: 2 }, { kind: 'stand', decidedAt: 1, releaseAt: Number.NaN }, null]) {
      const d = structuredClone(base);
      firstFlight(d).nightHold = bad;
      d.formatVersion = 4;
      expect(errorsOf(d)).toMatch(/nightHold/);
    }
    const noNight = JSON.parse(serializeProject(projectOf(makeSim(false, false)))) as D;
    firstFlight(noNight).nightHold = { kind: 'stand', decidedAt: 1, releaseAt: 2 };
    noNight.formatVersion = 4;
    noNight.versions.format = 4;
    expect(errorsOf(noNight)).toMatch(/nightOps/);
  });
});
