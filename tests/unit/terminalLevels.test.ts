import { describe, expect, it } from 'vitest';
import { placeTerminalArea, updateEntity } from '../../src/core/layout/operations';
import { TERMINAL_AREA_MIN_LEVEL, terminalAreaLevelProblem } from '../../src/core/layout/levelRules';
import { buildTerminalModel } from '../../src/core/terminal/model';
import { analyzeLayout } from '../../src/core/validation/validate';
import { buildProject, serializeProject, validateProject } from '../../src/core/io/project';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSandboxCompany } from '../../src/core/economy/company';
import { must } from './helpers';

/**
 * ターミナルを地下 3 階〜4 階へ拡張（ユーザー依頼 2026-11-18）。
 * エリアの階は地下 3 階（-3）から、ターミナルの階数（地上の階数）− 1 まで。
 * 階数プロパティの上限は 4（= 4 階まで）。
 */
const TERMINAL = 'fac_2';

describe('ターミナル内エリアの階の範囲（地下 3 階〜4 階）', () => {
  it('地下 3 階にエリアを置ける。地下 4 階は置けない', () => {
    const l = createSampleAirport();
    const ok = placeTerminalArea(l, TERMINAL, -3, 'waiting', { x: 50, y: 50 }, { w: 6, h: 2 });
    expect(ok.ok).toBe(true);
    const placed = must(ok);
    const area = Object.values(placed.layout.terminalAreas).find((a) => a.level === -3);
    expect(area).toBeDefined();
    expect(placeTerminalArea(l, TERMINAL, -4, 'waiting', { x: 50, y: 50 }, { w: 6, h: 2 }).ok).toBe(false);
    expect(TERMINAL_AREA_MIN_LEVEL).toBe(-3);
    expect(terminalAreaLevelProblem(l, TERMINAL, -3)).toBeNull();
    expect(terminalAreaLevelProblem(l, TERMINAL, -4)).toBe('floorOutOfRange');
  });

  it('地上はターミナルの階数まで。階数を 4 に上げると 4 階（level 3）に置ける', () => {
    let l = createSampleAirport(); // サンプルの階数は 2（level 0〜1）
    expect(placeTerminalArea(l, TERMINAL, 2, 'waiting', { x: 50, y: 50 }, { w: 6, h: 2 }).ok).toBe(false);
    l = must(updateEntity(l, TERMINAL, { props: { levels: 4 } })).layout;
    expect(placeTerminalArea(l, TERMINAL, 3, 'waiting', { x: 50, y: 50 }, { w: 6, h: 2 }).ok).toBe(true);
    // 階数の上限は 4
    expect(updateEntity(l, TERMINAL, { props: { levels: 5 } }).ok).toBe(false);
  });

  it('既存エリアの階を地下へ変更できる。範囲外は変更できない', () => {
    let l = createSampleAirport();
    l = must(updateEntity(l, 'ta_9', { level: -1 })).layout;
    expect(l.terminalAreas['ta_9']!.level).toBe(-1);
    expect(updateEntity(l, 'ta_9', { level: -4 }).ok).toBe(false);
  });

  it('地下のエリアは検証で「ターミナルの範囲外」にならない', () => {
    let l = createSampleAirport();
    l = must(placeTerminalArea(l, TERMINAL, -3, 'waiting', { x: 50, y: 50 }, { w: 6, h: 2 })).layout;
    const issues = analyzeLayout(l).issues.filter((i) => i.code === 'TERMINAL_AREA_OUTSIDE');
    expect(issues).toEqual([]);
  });

  it('地下のエリアと地上は、重なる上下移動エリア（エスカレーター）でつながる', () => {
    let l = createSampleAirport();
    // 地下 1 階: 待合（80,52）とエスカレーター（86,52。地上の ta_5 と同じ平面位置）
    l = must(placeTerminalArea(l, TERMINAL, -1, 'waiting', { x: 80, y: 52 }, { w: 6, h: 2 })).layout;
    l = must(placeTerminalArea(l, TERMINAL, -1, 'escalator', { x: 86, y: 52 }, { w: 4, h: 2 })).layout;
    const waiting = Object.values(l.terminalAreas).find((a) => a.level === -1 && a.kind === 'waiting')!;
    const lift = Object.values(l.terminalAreas).find((a) => a.level === -1 && a.kind === 'escalator')!;
    const model = buildTerminalModel(l);
    // 同じ階の共有辺で待合 ↔ エスカレーター
    expect(model.links[waiting.id]!.map((x) => x.to)).toContain(lift.id);
    // 平面が重なる上下移動エリア同士で 地下 1 階 ↔ 地上（ta_5）
    expect(model.links[lift.id]!.map((x) => x.to)).toContain('ta_5');
  });

  it('地下のエリアを含むレイアウトは保存・読み込みで階が保たれる', () => {
    let l = createSampleAirport();
    l = must(placeTerminalArea(l, TERMINAL, -3, 'waiting', { x: 50, y: 50 }, { w: 6, h: 2 })).layout;
    const p = buildProject({ name: 't', savedAt: '2026-11-18T00:00:00.000Z', layout: l, company: createSandboxCompany(), pin: null, scenarios: [], sim: null });
    const v = validateProject(serializeProject(p), { fallbackCompany: createSandboxCompany() });
    expect(v.ok).toBe(true);
    if (v.ok && v.project) {
      const area = Object.values(v.project.layout.terminalAreas).find((a) => a.level === -3);
      expect(area).toBeDefined();
    }
  });
});
