import { describe, expect, it } from 'vitest';
import { placeFacility, placeTerminalArea, updateEntity } from '../../src/core/layout/operations';
import {
  floorRangeInUse,
  terminalAreaLevelProblem,
  terminalFloorRange,
  terminalFloorRangeOf,
  undergroundFacilityProblem,
} from '../../src/core/layout/levelRules';
import { facilityVerticalRange } from '../../src/core/model/levels';
import { analyzeLayout } from '../../src/core/validation/validate';
import { buildProject, formatVersionOf, serializeProject, validateProject } from '../../src/core/io/project';
import { createSandboxCompany } from '../../src/core/economy/company';
import { facilityValue } from '../../src/core/economy/construction';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { terminalPlacementOf } from '../../src/editor/tools';
import { actions, editorStore } from '../../src/editor/store';
import type { Facility } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

/**
 * 機能G: 地下だけの建物（CDG 型）＋ floorRange（エリアの置ける階の建物別範囲）。
 * 設計は docs ではなく design-GHIJ-detail.md §G が正本。
 * 受入条件: floorRange を使わない既存レイアウトの解釈・検証結果は従来と完全一致すること。
 */

const termProps = (extra: Record<string, number> = {}) => ({ levels: 2, ...extra });

function placeUndergroundTerminal(levels = 2) {
  const l = emptyLayout(80, 60);
  const r = placeFacility(l, 'terminal', { x: 10, y: 10 }, {
    mapLevel: -2,
    props: termProps({ floorRangeMin: 0, floorRangeMax: levels - 1 }),
  });
  const layout = must(r).layout;
  const terminal = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!;
  return { layout, terminal };
}

describe('G1: 地下ターミナルの解禁と floorRange の読み取り', () => {
  it('地下にターミナルを単独配置できる。他の地上施設は引き続き置けない', () => {
    const l = emptyLayout(80, 60);
    expect(undergroundFacilityProblem('terminal', -1, false)).toBeNull();
    expect(undergroundFacilityProblem('terminal', -3, false)).toBeNull();
    expect(undergroundFacilityProblem('tower', -1, false)).toBe('undergroundKind');
    expect(placeFacility(l, 'terminal', { x: 10, y: 10 }, { mapLevel: -2, props: termProps() }).ok).toBe(true);
    expect(placeFacility(l, 'terminal', { x: 40, y: 10 }, { mapLevel: -1, props: termProps() }).ok).toBe(true);
    expect(placeFacility(l, 'tower', { x: 10, y: 30 }, { mapLevel: -1 }).ok).toBe(false);
  });

  it('配置後の階変更でもターミナルは地下へ移せる', () => {
    let l = emptyLayout(80, 60);
    l = must(placeFacility(l, 'terminal', { x: 10, y: 10 }, { props: termProps() })).layout;
    const id = Object.values(l.facilities).find((f) => f.kind === 'terminal')!.id;
    expect(updateEntity(l, id, { mapLevel: -1 }).ok).toBe(true);
  });

  it('floorRange 欠落 = 従来範囲 [-3, levels-1]、指定時はその範囲、不正値は従来範囲へ寄せる', () => {
    expect(terminalFloorRangeOf({}, 2)).toEqual({ min: -3, max: 1 });
    expect(terminalFloorRangeOf({ floorRangeMin: 0, floorRangeMax: 1 }, 2)).toEqual({ min: 0, max: 1 });
    expect(terminalFloorRangeOf({ floorRangeMin: -1 }, 3)).toEqual({ min: -1, max: 2 });
    // 非整数は欠落として扱う
    expect(terminalFloorRangeOf({ floorRangeMin: 0.5 }, 2)).toEqual({ min: -3, max: 1 });
    // min > max や範囲外はクランプして整合させる（読み込みで落とさない）
    expect(terminalFloorRangeOf({ floorRangeMin: 2, floorRangeMax: 0 }, 2)).toEqual({ min: 1, max: 1 });
    expect(terminalFloorRangeOf({ floorRangeMin: -9, floorRangeMax: 9 }, 2)).toEqual({ min: -3, max: 1 });
  });

  it('floorRange 付きターミナルではエリア配置・階変更が範囲で制限される', () => {
    let l = emptyLayout(80, 60);
    l = must(placeFacility(l, 'terminal', { x: 10, y: 10 }, { props: termProps({ floorRangeMin: 0, floorRangeMax: 1 }) })).layout;
    const t = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
    expect(terminalAreaLevelProblem(l, t.id, -1)).toBe('floorOutOfRange');
    expect(terminalAreaLevelProblem(l, t.id, 0)).toBeNull();
    expect(terminalAreaLevelProblem(l, t.id, 1)).toBeNull();
    expect(placeTerminalArea(l, t.id, -1, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 }).ok).toBe(false);
    const placed = placeTerminalArea(l, t.id, 0, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 });
    expect(placed.ok).toBe(true);
    const area = Object.values(must(placed).layout.terminalAreas)[0]!;
    expect(updateEntity(must(placed).layout, area.id, { level: -1 }).ok).toBe(false);
    expect(updateEntity(must(placed).layout, area.id, { level: 1 }).ok).toBe(true);
  });

  it('floorRange 欠落のターミナルは従来どおり B3 まで置ける（旧データ互換）', () => {
    let l = emptyLayout(80, 60);
    l = must(placeFacility(l, 'terminal', { x: 10, y: 10 }, { props: termProps() })).layout;
    const t = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
    expect(terminalFloorRange(l, t.id)).toEqual({ min: -3, max: 1 });
    expect(placeTerminalArea(l, t.id, -3, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 }).ok).toBe(true);
    expect(placeTerminalArea(l, t.id, 2, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 }).ok).toBe(false);
  });

  it('floorRange の変更は、範囲外になるエリアがあると拒否される', () => {
    let l = emptyLayout(80, 60);
    l = must(placeFacility(l, 'terminal', { x: 10, y: 10 }, { props: termProps() })).layout;
    const t = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
    l = must(placeTerminalArea(l, t.id, -3, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 })).layout;
    expect(floorRangeInUse(l, t.id, 0, 1)).toBe(true);
    expect(floorRangeInUse(l, t.id, -3, 1)).toBe(false);
    expect(updateEntity(l, t.id, { props: { floorRangeMin: 0 } }).ok).toBe(false);
    expect(updateEntity(l, t.id, { props: { floorRangeMin: -2 } }).ok).toBe(false);
    expect(updateEntity(l, t.id, { props: { floorRangeMin: -3 } }).ok).toBe(true);
    // クランプで化ける値（levels=2 で min=3）は書けない
    expect(updateEntity(l, t.id, { props: { floorRangeMin: 3 } }).ok).toBe(false);
  });
});

describe('G2: facilityVerticalRange の地下ターミナル区間修正', () => {
  const fac = (kind: Facility['kind'], mapLevel: number, props: Record<string, number>): Facility => ({
    id: 'f', kind, name: '', origin: { x: 0, y: 0 }, w: 4, h: 4, rotation: 0,
    buildState: 'operational', mapLevel, props,
  });

  it('地上ターミナルの区間は従来式と一致する', () => {
    const r = facilityVerticalRange(fac('terminal', 0, { levels: 2 }));
    expect(r.minM).toBeCloseTo(0);
    expect(r.maxM).toBeCloseTo(18 * (2 * 0.6)); // 従来: 高さ 18m × levels×0.6
    const r1 = facilityVerticalRange(fac('terminal', 1, { levels: 2 }));
    expect(r1.minM).toBeCloseTo(6);
    expect(r1.maxM).toBeCloseTo(6 + 18 * (2 * 0.6));
  });

  it('地下の単独施設（駐車場等）は従来の「自階層帯の天井」キャップのまま', () => {
    const r = facilityVerticalRange(fac('parking', -1, {}));
    expect(r.minM).toBeCloseTo(-6);
    expect(r.maxM).toBeLessThanOrEqual(-0.2 + 1e-9);
  });

  it('地下ターミナルは基底階から levels 層ぶんの区間を持つ', () => {
    expect(facilityVerticalRange(fac('terminal', -2, { levels: 2 }))).toEqual({ minM: -12, maxM: -0.2 });
    expect(facilityVerticalRange(fac('terminal', -1, { levels: 1 }))).toEqual({ minM: -6, maxM: -0.2 });
    // 地上へ跨ぐ棟（B1〜2F）は地上側まで占有する
    const s = facilityVerticalRange(fac('terminal', -1, { levels: 3 }));
    expect(s.minM).toBeCloseTo(-6);
    expect(s.maxM).toBeCloseTo(11.8);
  });

  it('地下棟の真上にエプロンを置け、重なりエラーにならない', () => {
    const { layout, terminal } = placeUndergroundTerminal();
    const withApron = placeFacility(layout, 'apron', { x: 10, y: 10 }, { w: 20, h: 8 });
    expect(withApron.ok).toBe(true);
    const issues = analyzeLayout(must(withApron).layout).issues;
    expect(issues.filter((i) => i.code === 'OVERLAP' && i.targets.includes(terminal.id))).toEqual([]);
  });

  it('地下棟と高さ区間が重なる建物は重なりエラーになる（対照）', () => {
    const { layout, terminal } = placeUndergroundTerminal();
    const other = placeFacility(layout, 'terminal', { x: 10, y: 10 }, { mapLevel: -1, props: termProps() });
    expect(other.ok).toBe(true);
    const issues = analyzeLayout(must(other).layout).issues;
    expect(issues.some((i) => i.code === 'OVERLAP' && i.targets.includes(terminal.id))).toBe(true);
  });
});

describe('G3: 孤立警告と地下ゲートのバス原則', () => {
  it('未接続の地下単独棟には TERMINAL_UNDERGROUND_ISOLATED が出る', () => {
    const { layout, terminal } = placeUndergroundTerminal();
    const l = must(placeTerminalArea(layout, terminal.id, 0, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 })).layout;
    const issues = analyzeLayout(l).issues;
    expect(issues.some((i) => i.code === 'TERMINAL_UNDERGROUND_ISOLATED' && i.targets.includes(terminal.id))).toBe(true);
  });

  it('入口エリアを持つ地下棟には警告が出ない（ランドサイド接続）', () => {
    const { layout, terminal } = placeUndergroundTerminal();
    const l = must(placeTerminalArea(layout, terminal.id, 0, 'entrance', { x: 12, y: 12 }, { w: 6, h: 2 })).layout;
    const issues = analyzeLayout(l).issues;
    expect(issues.some((i) => i.code === 'TERMINAL_UNDERGROUND_ISOLATED' && i.targets.includes(terminal.id))).toBe(false);
  });

  it('地上階のエリアを持つ跨ぎ棟には警告が出ない', () => {
    let l = emptyLayout(80, 60);
    l = must(placeFacility(l, 'terminal', { x: 10, y: 10 }, {
      mapLevel: -1, props: { levels: 3, floorRangeMin: 0, floorRangeMax: 2 },
    })).layout;
    const t = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
    l = must(placeTerminalArea(l, t.id, 2, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 })).layout; // 実効 +1F
    const issues = analyzeLayout(l).issues;
    expect(issues.some((i) => i.code === 'TERMINAL_UNDERGROUND_ISOLATED' && i.targets.includes(t.id))).toBe(false);
  });

  it('基底が地上でも全エリアが地下なら地下棟として警告する', () => {
    let l = emptyLayout(80, 60);
    l = must(placeFacility(l, 'terminal', { x: 10, y: 10 }, {
      props: { levels: 2, floorRangeMin: -3, floorRangeMax: -1 },
    })).layout;
    const t = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
    l = must(placeTerminalArea(l, t.id, -1, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 })).layout;
    const issues = analyzeLayout(l).issues;
    expect(issues.some((i) => i.code === 'TERMINAL_UNDERGROUND_ISOLATED' && i.targets.includes(t.id))).toBe(true);
  });

  it('既存のサンプル空港では地下孤立警告は出ない（従来レイアウト不変）', () => {
    const issues = analyzeLayout(createSampleAirport()).issues;
    expect(issues.filter((i) => i.code === 'TERMINAL_UNDERGROUND_ISOLATED')).toEqual([]);
    expect(issues.filter((i) => i.code === 'GATE_UNDERGROUND_BRIDGE')).toEqual([]);
  });

  it('地下ゲートで jetBridge が有効だと GATE_UNDERGROUND_BRIDGE、バス/無効なら出ない', () => {
    const { layout, terminal } = placeUndergroundTerminal();
    const withGate = placeFacility(layout, 'gate', { x: 12, y: 12 }, { parentFacilityId: terminal.id, floorIndex: 0 });
    expect(withGate.ok).toBe(true);
    const l = must(withGate).layout;
    const gate = Object.values(l.facilities).find((f) => f.kind === 'gate')!;
    expect(gate.props.jetBridge).toBe(true); // 既定でブリッジ有効
    expect(analyzeLayout(l).issues.some((i) => i.code === 'GATE_UNDERGROUND_BRIDGE' && i.targets.includes(gate.id))).toBe(true);
    const noBridge = must(updateEntity(l, gate.id, { props: { jetBridge: false } })).layout;
    expect(analyzeLayout(noBridge).issues.some((i) => i.code === 'GATE_UNDERGROUND_BRIDGE')).toBe(false);
    const bus = must(updateEntity(l, gate.id, { props: { boardingMode: 'bus' } })).layout;
    expect(analyzeLayout(bus).issues.some((i) => i.code === 'GATE_UNDERGROUND_BRIDGE')).toBe(false);
  });
});

describe('G4: 建物生成の変換規則と往復保存', () => {
  it('絶対階の選択が mapLevel / levels / floorRange に変換される', () => {
    const conv = (min: number, max: number) => {
      actions.setOption('terminalFloorMin', min);
      actions.setOption('terminalFloorMax', max);
      return terminalPlacementOf(editorStore.getState().options);
    };
    expect(conv(-2, -1)).toEqual({ mapLevel: -2, props: { levels: 2, floorRangeMin: 0, floorRangeMax: 1 } });
    expect(conv(-1, -1)).toEqual({ mapLevel: -1, props: { levels: 1, floorRangeMin: 0, floorRangeMax: 0 } });
    expect(conv(0, 1)).toEqual({ mapLevel: 0, props: { levels: 2, floorRangeMin: 0, floorRangeMax: 1 } });
    expect(conv(-1, 1)).toEqual({ mapLevel: -1, props: { levels: 3, floorRangeMin: 0, floorRangeMax: 2 } });
    // 総階数は検証上限 4 に丸める
    expect(conv(-3, 3).props.levels).toBe(4);
    actions.setOption('terminalFloorMin', 0);
    actions.setOption('terminalFloorMax', 1);
  });

  it('B2〜B1 の棟が変換どおり保存され、再読込で一致する（formatVersion は上がらない）', () => {
    const { layout, terminal } = placeUndergroundTerminal();
    const company = createSandboxCompany();
    const p = buildProject({ name: 'g', savedAt: '2026-11-20T00:00:00.000Z', layout, company, pin: null, scenarios: [], sim: null });
    const v = validateProject(serializeProject(p), { fallbackCompany: createSandboxCompany() });
    expect(v.ok).toBe(true);
    if (v.ok && v.project) {
      const t = v.project.layout.facilities[terminal.id]!;
      expect(t.mapLevel).toBe(-2);
      expect(t.props.levels).toBe(2);
      expect(t.props.floorRangeMin).toBe(0);
      expect(t.props.floorRangeMax).toBe(1);
    }
    // floorRange を持たない同じ形のレイアウトと formatVersion が同じ（props 追加だけでは版を上げない）
    const plain = must(placeFacility(emptyLayout(80, 60), 'terminal', { x: 10, y: 10 }, { mapLevel: -2, props: termProps() })).layout;
    const p2 = buildProject({ name: 'g2', savedAt: '2026-11-20T00:00:00.000Z', layout: plain, company, pin: null, scenarios: [], sim: null });
    expect(formatVersionOf(p)).toBe(formatVersionOf(p2));
  });

  it('floorRange 欠落の旧データは往復しても props にキーが生えない', () => {
    const l = must(placeFacility(emptyLayout(80, 60), 'terminal', { x: 10, y: 10 }, { props: termProps() })).layout;
    const t = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
    const p = buildProject({ name: 'g3', savedAt: '2026-11-20T00:00:00.000Z', layout: l, company: createSandboxCompany(), pin: null, scenarios: [], sim: null });
    const v = validateProject(serializeProject(p), { fallbackCompany: createSandboxCompany() });
    expect(v.ok).toBe(true);
    if (v.ok && v.project) {
      expect('floorRangeMin' in v.project.layout.facilities[t.id]!.props).toBe(false);
      expect('floorRangeMax' in v.project.layout.facilities[t.id]!.props).toBe(false);
    }
  });
});

describe('G5: 建設費の地下係数', () => {
  const fac = (mapLevel: number): Facility => ({
    id: 'f', kind: 'terminal', name: '', origin: { x: 0, y: 0 }, w: 10, h: 10, rotation: 0,
    buildState: 'operational', mapLevel, props: { levels: 2 },
  });

  it('地上ターミナルは従来どおり、地下は深さ 1 階につき ×1.5', () => {
    expect(facilityValue(fac(0))).toBe(10 * 10 * 20_000 * 2);
    expect(facilityValue(fac(-1))).toBe(Math.round(10 * 10 * 20_000 * 2 * 1.5));
    expect(facilityValue(fac(-2))).toBe(Math.round(10 * 10 * 20_000 * 2 * 1.5 * 1.5));
  });
});
