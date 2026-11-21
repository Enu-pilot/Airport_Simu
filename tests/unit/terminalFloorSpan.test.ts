import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { placeFacility, placeTerminalArea, updateEntity } from '../../src/core/layout/operations';
import { floorRangeInUse, terminalAreaLevelProblem, terminalFloorRange, terminalSpanPatch } from '../../src/core/layout/levelRules';
import { buildProject, serializeProject, validateProject } from '../../src/core/io/project';
import { createSandboxCompany } from '../../src/core/economy/company';
import { TerminalFloorAdvancedFields, TerminalFloorSpanFields } from '../../src/ui/PropertiesPanel';
import type { AirportLayout } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

/**
 * 階範囲のプルダウン一本化: 建物の最下階・最上階（絶対階）から基底階・階数を導く。
 * 計画: docs/implementation/active/terminal_floor_span_unification_plan.md
 * 前提（機能G）: 配置時の変換規則（基底階 = 最下階、階数 = 最上階 − 最下階 + 1、
 * floorRange = [0, 階数 − 1]）と、floorRange 欠落の旧データの解釈は変えない。
 */

function place(layout: AirportLayout, opts: Parameters<typeof placeFacility>[3] = {}) {
  const r = placeFacility(layout, 'terminal', { x: 10, y: 10 }, opts);
  const l = must(r).layout;
  const t = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
  return { layout: l, terminal: t };
}

function applySpan(layout: AirportLayout, terminalId: string, absMin: number, absMax: number) {
  const patch = terminalSpanPatch(layout, terminalId, absMin, absMax);
  expect(patch).not.toBeNull();
  const r = updateEntity(layout, terminalId, {
    mapLevel: patch!.mapLevel,
    props: { levels: patch!.levels, floorRangeMin: patch!.floorRangeMin, floorRangeMax: patch!.floorRangeMax },
  });
  return must(r).layout;
}

describe('terminalSpanPatch: 導出（配置時の変換規則と同一）', () => {
  it('地上の旧建物（floorRange 欠落）を地下だけの建物にできる。下限の相対オフセットは保持する', () => {
    const { layout, terminal } = place(emptyLayout(), { props: { levels: 2 } });
    const patch = terminalSpanPatch(layout, terminal.id, -2, -1);
    // 基底階 = 最下階、階数 = 2。エリア下限は旧定値（-3 = 基底より下の許可）を保持し、上限は最上階に一致
    expect(patch).toEqual({ mapLevel: -2, levels: 2, floorRangeMin: -3, floorRangeMax: 1 });
    const after = applySpan(layout, terminal.id, -2, -1);
    const t = after.facilities[terminal.id]!;
    expect(t.mapLevel).toBe(-2);
    expect(t.props.levels).toBe(2);
    expect(terminalFloorRange(after, terminal.id)).toEqual({ min: -3, max: 1 });
  });

  it('配置済みの地下棟（floorRange [0, 階数-1]）を跨ぎ・地上へ広げられる', () => {
    const { layout, terminal } = place(emptyLayout(), {
      mapLevel: -2,
      props: { levels: 2, floorRangeMin: 0, floorRangeMax: 1 },
    });
    expect(terminalSpanPatch(layout, terminal.id, -2, 0)).toEqual({ mapLevel: -2, levels: 3, floorRangeMin: 0, floorRangeMax: 2 });
    const after = applySpan(layout, terminal.id, 0, 1);
    const t = after.facilities[terminal.id]!;
    expect(t.mapLevel).toBe(0);
    expect(t.props.levels).toBe(2);
    expect(terminalFloorRange(after, terminal.id)).toEqual({ min: 0, max: 1 });
  });

  it('最上階を上げると、新しい階にエリアを置けるようになる（従来の「階数だけ上げても置けない」を解消）', () => {
    const { layout, terminal } = place(emptyLayout(), { props: { levels: 2, floorRangeMin: 0, floorRangeMax: 1 } });
    expect(terminalAreaLevelProblem(layout, terminal.id, 3)).toBe('floorOutOfRange');
    const after = applySpan(layout, terminal.id, 0, 3);
    expect(after.facilities[terminal.id]!.props.levels).toBe(4);
    expect(terminalAreaLevelProblem(after, terminal.id, 3)).toBeNull();
    expect(placeTerminalArea(after, terminal.id, 3, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 }).ok).toBe(true);
  });

  it('旧データの地下エリア（基底より下）は、下限保持のため範囲変更で意味が変わらない', () => {
    const placed = place(emptyLayout(), { props: { levels: 2 } });
    const terminal = placed.terminal;
    const layout = must(placeTerminalArea(placed.layout, terminal.id, -1, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 })).layout;
    // 基底を動かさない拡張では、地下エリアは範囲内のまま残る
    const after = applySpan(layout, terminal.id, 0, 3);
    const areas = Object.values(after.terminalAreas).filter((a) => a.terminalId === terminal.id);
    expect(areas.map((a) => a.level)).toEqual([-1]);
    expect(terminalFloorRange(after, terminal.id)).toEqual({ min: -3, max: 3 });
  });
});

describe('terminalSpanPatch: 拒否ケース', () => {
  it('範囲外になるエリアがあると変えられない（最上階を下げる）', () => {
    const placed = place(emptyLayout(), { props: { levels: 2, floorRangeMin: 0, floorRangeMax: 1 } });
    const terminal = placed.terminal;
    const layout = must(placeTerminalArea(placed.layout, terminal.id, 1, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 })).layout;
    expect(terminalSpanPatch(layout, terminal.id, 0, 0)).toBeNull();
    // コア側でも同じ patch は拒否される（UI の事前判定と二重に守る）
    expect(updateEntity(layout, terminal.id, { mapLevel: 0, props: { levels: 1, floorRangeMin: 0, floorRangeMax: 0 } }).ok).toBe(false);
  });

  it('新しい階数以上に内包施設があると変えられない', () => {
    const { layout, terminal } = place(emptyLayout(), { props: { levels: 2, floorRangeMin: 0, floorRangeMax: 1 } });
    const withGate = placeFacility(layout, 'gate', { x: 12, y: 12 }, { parentFacilityId: terminal.id, floorIndex: 1 });
    expect(withGate.ok).toBe(true);
    expect(terminalSpanPatch(must(withGate).layout, terminal.id, 0, 0)).toBeNull();
    expect(terminalSpanPatch(must(withGate).layout, terminal.id, 0, 1)).not.toBeNull();
  });

  it('不正な絶対範囲は変えられない（総階数 5・min > max・対象外）', () => {
    const { layout, terminal } = place(emptyLayout(), { props: { levels: 2 } });
    expect(terminalSpanPatch(layout, terminal.id, -3, 1)).toBeNull(); // 総階数 5
    expect(terminalSpanPatch(layout, terminal.id, 0, 3)).not.toBeNull(); // 総階数 4 は可
    expect(terminalSpanPatch(layout, terminal.id, 1, 0)).toBeNull();
    expect(terminalSpanPatch(layout, 'no-such-id', 0, 1)).toBeNull();
  });
});

describe('旧セーブ互換: 往復保存で意味が変わらない', () => {
  it('floorRange 欠落の旧建物に範囲変更（基底を動かさない拡張）をしても、エリアの階と実効範囲が保たれる', () => {
    const placed = place(emptyLayout(), { props: { levels: 2 } });
    const terminal = placed.terminal;
    let layout = must(placeTerminalArea(placed.layout, terminal.id, -1, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 })).layout;
    layout = must(placeTerminalArea(layout, terminal.id, 1, 'waiting', { x: 12, y: 20 }, { w: 6, h: 2 })).layout;
    const after = applySpan(layout, terminal.id, 0, 3);
    const company = createSandboxCompany();
    const p = buildProject({ name: 'span', savedAt: '2026-11-21T00:00:00.000Z', layout: after, company, pin: null, scenarios: [], sim: null });
    const v = validateProject(serializeProject(p), { fallbackCompany: createSandboxCompany() });
    expect(v.ok).toBe(true);
    if (v.ok && v.project) {
      const t = v.project.layout.facilities[terminal.id]!;
      expect(t.mapLevel ?? 0).toBe(0);
      expect(t.props.levels).toBe(4);
      // 明示化された floorRange は、欠落時に levels=4 で解決される既定 [-3, 3] と一致する（意味不変）
      expect(t.props.floorRangeMin).toBe(-3);
      expect(t.props.floorRangeMax).toBe(3);
      const levels = Object.values(v.project.layout.terminalAreas).map((a) => a.level).sort();
      expect(levels).toEqual([-1, 1]);
    }
  });
});

describe('詳細設定: エリア範囲の絞り込み（建物の階範囲とは独立）', () => {
  it('建物の階範囲を変えずに、エリアを置ける上限だけを絞れる', () => {
    const { layout, terminal } = place(emptyLayout(), { props: { levels: 4, floorRangeMin: 0, floorRangeMax: 3 } });
    const r = updateEntity(layout, terminal.id, { props: { floorRangeMax: 1 } });
    expect(r.ok).toBe(true);
    const after = must(r).layout;
    const t = after.facilities[terminal.id]!;
    // 建物の階範囲（基底階・階数）は不変で、エリア範囲だけが狭くなる
    expect(t.mapLevel ?? 0).toBe(0);
    expect(t.props.levels).toBe(4);
    expect(terminalFloorRange(after, terminal.id)).toEqual({ min: 0, max: 1 });
    expect(terminalAreaLevelProblem(after, terminal.id, 2)).toBe('floorOutOfRange');
    expect(terminalAreaLevelProblem(after, terminal.id, 1)).toBeNull();
    expect(placeTerminalArea(after, terminal.id, 1, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 }).ok).toBe(true);
  });

  it('範囲外になるエリアがある絞り込みは、UI 判定・コアの双方で拒否される', () => {
    const placed = place(emptyLayout(), { props: { levels: 4, floorRangeMin: 0, floorRangeMax: 3 } });
    const terminal = placed.terminal;
    const layout = must(placeTerminalArea(placed.layout, terminal.id, 3, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 })).layout;
    // 上限を下げる絞り込み: 3F のエリアが範囲外になる
    expect(floorRangeInUse(layout, terminal.id, 0, 1)).toBe(true);
    expect(updateEntity(layout, terminal.id, { props: { floorRangeMax: 1 } }).ok).toBe(false);
    // 下限を上げる絞り込み: 0F に置き直しても同じく拒否される
    const layout0 = must(placeTerminalArea(placed.layout, terminal.id, 0, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 })).layout;
    expect(floorRangeInUse(layout0, terminal.id, 1, 3)).toBe(true);
    expect(updateEntity(layout0, terminal.id, { props: { floorRangeMin: 1 } }).ok).toBe(false);
  });

  it('下限の「基底より下」の許可は、絞り込みでも壊れない（旧データの地下エリア）', () => {
    const placed = place(emptyLayout(), { props: { levels: 2 } });
    const terminal = placed.terminal;
    // floorRange 欠落の既定は [-3, 1]。基底（0）より下の -1 にエリアがある
    const layout = must(placeTerminalArea(placed.layout, terminal.id, -1, 'waiting', { x: 12, y: 12 }, { w: 6, h: 2 })).layout;
    // 上限だけを 0 に絞っても、下限の既定（-3）と地下エリアは保たれる
    const narrowed = must(updateEntity(layout, terminal.id, { props: { floorRangeMax: 0 } })).layout;
    expect(terminalFloorRange(narrowed, terminal.id)).toEqual({ min: -3, max: 0 });
    expect(floorRangeInUse(narrowed, terminal.id, -3, 0)).toBe(false);
    // 下限を -2 まで絞るのは可（エリアは -1）。0 まで上げると範囲外になり拒否
    expect(updateEntity(narrowed, terminal.id, { props: { floorRangeMin: -2 } }).ok).toBe(true);
    expect(updateEntity(narrowed, terminal.id, { props: { floorRangeMin: 0 } }).ok).toBe(false);
  });
});

describe('PropertiesPanel: 階コントロールの一本化', () => {
  // パネル本体は zustand の初期状態を読む SSR では選択状態を再現できないため、
  // 既存テスト（TerminalComplexInfo の描画）と同じく export 済みサブコンポーネントを描画して確認する
  it('絶対階プルダウン対が出て、現在の建物範囲が選択されている（地下棟 B2〜B1）', () => {
    const { layout, terminal } = place(emptyLayout(), {
      mapLevel: -2,
      props: { levels: 2, floorRangeMin: 0, floorRangeMax: 1 },
    });
    const html = renderToString(createElement(TerminalFloorSpanFields, { layout, id: terminal.id }));
    expect(html).toContain('data-testid="prop-spanMin"');
    expect(html).toContain('data-testid="prop-spanMax"');
    expect(html).toContain('建物の最下階');
    expect(html).toContain('建物の最上階');
    // 最下階 = -2（B2F）、最上階 = -1（B1F）が選択されている
    expect(html).toMatch(/value="-2" selected=""/);
    expect(html).toMatch(/value="-1" selected=""/);
    // 総階数 4 を超える組み合わせ（最下階 -3 は最上階 -1 に対して 3 階なので有効、最上階 3 は 6 階で無効）
    expect(html).toMatch(/value="3"[^>]*disabled=""/);
  });

  it('地上棟（1F〜2F）では最下階 0・最上階 1 が選択される', () => {
    const { layout, terminal } = place(emptyLayout(), { props: { levels: 2 } });
    const html = renderToString(createElement(TerminalFloorSpanFields, { layout, id: terminal.id }));
    expect(html).toMatch(/value="0" selected=""/);
    expect(html).toMatch(/value="1" selected=""/);
  });

  it('詳細設定（折りたたみ）にエリア範囲の絞り込みプルダウンがあり、現在の範囲が選択されている', () => {
    const { layout, terminal } = place(emptyLayout(), { props: { levels: 4, floorRangeMin: 0, floorRangeMax: 3 } });
    const html = renderToString(createElement(TerminalFloorAdvancedFields, { layout, id: terminal.id }));
    expect(html).toContain('<details');
    expect(html).toContain('data-testid="prop-floorAdvanced"');
    expect(html).toContain('詳細設定');
    expect(html).toContain('data-testid="prop-floorRangeMin"');
    expect(html).toContain('data-testid="prop-floorRangeMax"');
    // 現在のエリア範囲（相対 0〜3）が選択されている
    expect(html).toMatch(/value="0" selected=""/);
    expect(html).toMatch(/value="3" selected=""/);
  });
});
