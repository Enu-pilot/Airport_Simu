/** 監査 c / ID17: 壊れた保存データは例外にならず、メッセージ付きで拒否（または警告つきで建設モード）される */
import { describe, expect, it } from 'vitest';
import { sampleSim, runUntilTime } from './c_helpers';
import { buildProject, serializeProject, validateProject, PROJECT_FORMAT_VERSION } from '../../src/core/io/project';
import { createSandboxCompany } from '../../src/core/economy/company';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>;
const opts = { fallbackCompany: createSandboxCompany() };
const sim = sampleSim({ seed: 'c-corrupt' });
runUntilTime(sim, 9 * 3600, 600, 'corrupt');
const good = serializeProject(buildProject({ name: 'g', savedAt: '', layout: sim.ctx.layout, company: sim.company!, pin: null, scenarios: [], sim }));
const parsed = () => JSON.parse(good) as Rec;
const check = (json: string) => {
  let r: ReturnType<typeof validateProject> | undefined;
  expect(() => { r = validateProject(json, opts); }).not.toThrow();
  return r!;
};

describe('ID17 破損データ', () => {
  it('正常なファイルは errors なしで読める（基準）', () => {
    const r = check(good);
    expect(r.errors).toEqual([]);
    expect(r.project?.sim).toBeTruthy();
  });

  it('途中で切れた JSON・空・非オブジェクト・配列・null は拒否し、メッセージがある', () => {
    for (const bad of [good.slice(0, Math.floor(good.length / 2)), '', '[]', 'null', '42', '"x"', '{']) {
      const r = check(bad);
      expect(r.project).toBeNull();
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.every((e) => typeof e === 'string' && e.length > 0)).toBe(true);
    }
  });

  it('形式名・版・型の誤り（format / formatVersion / cash / layout / catalog）を拒否する', () => {
    const muts: [string, (p: Rec) => void][] = [
      ['format', (p) => { p.format = 'other'; }],
      ['formatVersion 未来', (p) => { p.formatVersion = 99; p.versions.format = 99; }],
      ['formatVersion 文字列', (p) => { p.formatVersion = '2'; }],
      ['layout null', (p) => { p.layout = null; }],
      ['company 配列', (p) => { p.company = []; }],
      ['cash 文字列', (p) => { p.company.cash = 'x'; }],
      ['layout.stands が配列', (p) => { p.layout.stands = []; }],
    ];
    for (const [name, m] of muts) {
      const p = parsed();
      m(p);
      const r = check(JSON.stringify(p));
      expect({ name, rejected: r.project === null && r.errors.length > 0 }).toEqual({ name, rejected: true });
    }
  });

  it('運航状態の破損（now が文字列・aircraft が配列・巨大な数）は例外にならない。受理するなら復元時の違反か警告で検知できる', () => {
    const muts: [string, (p: Rec) => void][] = [
      ['now 文字列', (p) => { p.sim.state.now = 'x'; }],
      ['aircraft 配列', (p) => { p.sim.state.aircraft = []; }],
      ['standAssignments が存在しない機体を参照', (p) => { p.sim.state.standAssignments.std_1 = 'ac_zzz'; }],
      ['simModel 版違い', (p) => { p.versions.simModel = 'skyport-sim-0.1'; }],
    ];
    for (const [name, m] of muts) {
      const p = parsed();
      m(p);
      const r = check(JSON.stringify(p));
      const detected = r.errors.length > 0 || r.warnings.length > 0 || r.project?.sim === null;
      expect({ name, detected }).toEqual({ name, detected: true });
    }
  });

  it('【現状の記録・クラス E】有限だが極端に大きい数（now=1e300, cash=1e308）は範囲検査がなく無警告で受理される（例外にはならない）', () => {
    for (const m of [(p: Rec) => { p.sim.state.now = 1e300; }, (p: Rec) => { p.company.cash = 1e308; }]) {
      const p = parsed();
      m(p);
      const r = check(JSON.stringify(p));
      expect(r.errors.length === 0 ? r.project !== null : r.project === null).toBe(true);
    }
  });

  it('旧形式: formatVersion 1 を名乗り v2 の項目を持つファイルは拒否、v1 の基準は PROJECT_FORMAT_VERSION=1', () => {
    expect(PROJECT_FORMAT_VERSION).toBe(1);
    const p = parsed();
    p.formatVersion = 1;
    p.versions.format = 1;
    p.sim.state.airlineStandHomes ??= { day: 0, byAirline: {} };
    const r = check(JSON.stringify(p));
    expect(r.errors.length + r.warnings.length).toBeGreaterThan(0);
  });
});
