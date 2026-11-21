import { beforeEach, describe, expect, it } from 'vitest';
import { createHistory } from '../../src/core/editor/history';
import { createSandboxCompany } from '../../src/core/economy/company';
import { taxiwayRouteEdges } from '../../src/core/layout/network';
import { addTaxiwayPath, setTaxiwayRouteWidth, updateEntity } from '../../src/core/layout/operations';
import type { AirportLayout } from '../../src/core/model/types';
import { actions, applyOp, editorStore, type EditorState } from '../../src/editor/store';
import { onKeyDown } from '../../src/editor/input';
import { emptyLayout, must } from './helpers';

/**
 * 配置済み誘導路の幅の一括変更（docs/06 §4.1.1「選択中の誘導路への適用」）。
 * 経路 = 起点区間から両方向へ、接する区間がちょうど2本のノードだけを通過する連結
 * （分岐・合流と端点で止まる）。変更は setTaxiwayRouteWidth の1操作で原子的。
 */

const path = (l: AirportLayout, pts: readonly { x: number; y: number }[], widthClass: 'S' | 'M' | 'L' = 'M'): AirportLayout =>
  must(addTaxiwayPath(l, pts, { widthClass })).layout;

const edgeIds = (l: AirportLayout): string[] => Object.keys(l.taxiways);
const widths = (l: AirportLayout): Record<string, string> =>
  Object.fromEntries(Object.values(l.taxiways).map((e) => [e.id, e.widthClass]));

/** 直線チェーン3区間（x=10→40, y=10）。中間ノードは次数2、両端は次数1 */
function chainLayout(): AirportLayout {
  return path(emptyLayout(80, 60), [
    { x: 10, y: 10 },
    { x: 20, y: 10 },
    { x: 30, y: 10 },
    { x: 40, y: 10 },
  ]);
}

/** T字: 横チェーンの途中ノード（x=20,y=10、次数3）から南へ分岐 */
function branchLayout(): { layout: AirportLayout; main: string[]; branch: string } {
  let l = path(emptyLayout(80, 60), [
    { x: 10, y: 10 },
    { x: 20, y: 10 },
    { x: 30, y: 10 },
  ]);
  const main = edgeIds(l);
  l = path(l, [
    { x: 20, y: 10 },
    { x: 20, y: 20 },
  ]);
  const branch = edgeIds(l).find((id) => !main.includes(id))!;
  return { layout: l, main, branch };
}

describe('taxiwayRouteEdges（経路の算出）', () => {
  it('直線チェーンでは、どの区間からでも全区間が経路になる', () => {
    const l = chainLayout();
    const ids = edgeIds(l);
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      expect(new Set(taxiwayRouteEdges(l, id))).toEqual(new Set(ids));
    }
  });

  it('分岐（次数3のノード）で止まる', () => {
    const { layout: l, main, branch } = branchLayout();
    // 分岐側の区間は単独（両端とも次数1・次数3）
    expect(taxiwayRouteEdges(l, branch)).toEqual([branch]);
    // 本線の各区間も分岐点で止まるので単独
    for (const id of main) {
      expect(taxiwayRouteEdges(l, id)).toEqual([id]);
    }
  });

  it('分岐の先のチェーンは、分岐点から先だけで連なる', () => {
    let l = path(emptyLayout(80, 60), [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 30, y: 10 },
    ]);
    const main = edgeIds(l);
    l = path(l, [
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 20, y: 30 },
    ]);
    const branchChain = edgeIds(l).filter((id) => !main.includes(id));
    expect(branchChain).toHaveLength(2);
    for (const id of branchChain) {
      expect(new Set(taxiwayRouteEdges(l, id))).toEqual(new Set(branchChain));
    }
  });

  it('単独区間（両端が端点）は起点のみ', () => {
    const l = path(emptyLayout(80, 60), [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
    ]);
    const [id] = edgeIds(l);
    expect(taxiwayRouteEdges(l, id!)).toEqual([id]);
  });

  it('環状の接続でも全区間を集めて止まる（無限ループしない）', () => {
    const l = path(emptyLayout(80, 60), [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 10, y: 20 },
      { x: 10, y: 10 },
    ]);
    const ids = edgeIds(l);
    expect(ids).toHaveLength(4);
    for (const id of ids) {
      expect(new Set(taxiwayRouteEdges(l, id))).toEqual(new Set(ids));
    }
  });

  it('存在しないエッジは空配列', () => {
    expect(taxiwayRouteEdges(chainLayout(), 'twy_999')).toEqual([]);
  });
});

describe('setTaxiwayRouteWidth（一括変更）', () => {
  it('経路内の全区間の幅が変わり、経路外は変わらない', () => {
    const { layout: l0, branch } = branchLayout();
    // 本線は分岐で寸断されるので、チェーン側で確認する
    const l = chainLayout();
    const [first] = edgeIds(l);
    const r = setTaxiwayRouteWidth(l, first!, 'L');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.values(r.layout.taxiways).every((e) => e.widthClass === 'L')).toBe(true);
    }
    // 分岐した先は対象外
    const rb = setTaxiwayRouteWidth(l0, branch, 'S');
    expect(rb.ok).toBe(true);
    if (rb.ok) {
      expect(rb.layout.taxiways[branch]!.widthClass).toBe('S');
      for (const [id, e] of Object.entries(rb.layout.taxiways)) {
        if (id !== branch) expect(e.widthClass).toBe('M');
      }
    }
  });

  it('入力レイアウトを変更しない（純関数）', () => {
    const l = chainLayout();
    const [first] = edgeIds(l);
    const before = widths(l);
    setTaxiwayRouteWidth(l, first!, 'L');
    expect(widths(l)).toEqual(before);
  });

  it('全区間が既に同じ幅なら NO_CHANGE、無いエッジは NOT_FOUND、不正な幅は INVALID_VALUE', () => {
    const l = chainLayout();
    const [first] = edgeIds(l);
    const same = setTaxiwayRouteWidth(l, first!, 'M');
    expect(same).toEqual({ ok: false, reason: 'NO_CHANGE' });
    expect(setTaxiwayRouteWidth(l, 'twy_999', 'L')).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(setTaxiwayRouteWidth(l, first!, 'X' as never)).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });

  it('一部の区間だけ違う幅でも、残りを揃えれば成功する', () => {
    let l = chainLayout();
    const ids = edgeIds(l);
    l = must(updateEntity(l, ids[1]!, { widthClass: 'L' })).layout;
    const r = setTaxiwayRouteWidth(l, ids[0]!, 'L');
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.values(r.layout.taxiways).every((e) => e.widthClass === 'L')).toBe(true);
  });

  it('codeF の扱いは単一更新と一致する（L から下げても codeF は残る）', () => {
    let l = path(emptyLayout(80, 60), [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 30, y: 10 },
    ], 'L');
    const ids = edgeIds(l);
    l = must(updateEntity(l, ids[0]!, { codeF: true })).layout;
    expect(l.taxiways[ids[0]!]!.codeF).toBe(true);

    // 単一更新で幅を下げても codeF は残る（従来の挙動）
    const single = must(updateEntity(l, ids[0]!, { widthClass: 'M' })).layout;
    expect(single.taxiways[ids[0]!]!.widthClass).toBe('M');
    expect(single.taxiways[ids[0]!]!.codeF).toBe(true);

    // 一括変更でも同じ: codeF を持つ区間はそのまま保持される
    const bulk = must(setTaxiwayRouteWidth(l, ids[1]!, 'M')).layout;
    expect(bulk.taxiways[ids[0]!]!.widthClass).toBe('M');
    expect(bulk.taxiways[ids[0]!]!.codeF).toBe(true);
  });
});

describe('ストア経由（Undo・キー操作）', () => {
  const setStore = (layout: AirportLayout, patch: Partial<EditorState> = {}): void => {
    editorStore.setState({
      history: createHistory(layout),
      company: createSandboxCompany(),
      selection: null,
      draft: null,
      mode: 'build',
      tool: 'select',
      charges: { past: [], future: [] },
      ...patch,
    } as Partial<EditorState>);
  };
  const state = () => editorStore.getState();
  const key = (k: string) => onKeyDown({ key: k, ctrl: false, shift: false });

  beforeEach(() => {
    setStore(chainLayout());
    actions.setOption('taxiWidth', 'M');
  });

  it('一括変更は Undo 1回で経路全体が戻る（原子的な1操作）', () => {
    const l = state().history.present;
    const [first] = edgeIds(l);
    expect(applyOp(setTaxiwayRouteWidth(l, first!, 'L'))).toBe(true);
    expect(Object.values(state().history.present.taxiways).every((e) => e.widthClass === 'L')).toBe(true);
    actions.undo();
    expect(Object.values(state().history.present.taxiways).every((e) => e.widthClass === 'M')).toBe(true);
  });

  it('選択中の誘導路に S/M/L/F: 経路全体の幅が変わり、ツール側のオプションは変わらない', () => {
    const l = state().history.present;
    const ids = edgeIds(l);
    actions.select(ids[1]!);
    expect(key('l')).toBe(true);
    expect(Object.values(state().history.present.taxiways).every((e) => e.widthClass === 'L')).toBe(true);
    expect(state().options.taxiWidth).toBe('M');
    expect(key('s')).toBe(true);
    expect(Object.values(state().history.present.taxiways).every((e) => e.widthClass === 'S')).toBe(true);
    expect(key('f')).toBe(true); // F は最大（L）の別名
    expect(Object.values(state().history.present.taxiways).every((e) => e.widthClass === 'L')).toBe(true);
  });

  it('分岐で寸断された経路では、キーでも選んだ側だけが変わる', () => {
    const { layout: l, branch } = branchLayout();
    setStore(l);
    actions.select(branch);
    expect(key('s')).toBe(true);
    const after = state().history.present;
    expect(after.taxiways[branch]!.widthClass).toBe('S');
    for (const [id, e] of Object.entries(after.taxiways)) {
      if (id !== branch) expect(e.widthClass).toBe('M');
    }
  });

  it('誘導路以外を選択中・未選択ではサイズキーは素通りする', () => {
    const l = state().history.present;
    const nodeId = Object.keys(l.taxiNodes)[0]!;
    actions.select(nodeId);
    expect(key('l')).toBe(false);
    expect(Object.values(state().history.present.taxiways).every((e) => e.widthClass === 'M')).toBe(true);
    actions.select(null);
    expect(key('l')).toBe(false);
    expect(state().options.taxiWidth).toBe('M');
  });

  it('誘導路ツール選択中は従来どおり「これから置く幅」が変わる（配置済みは変わらない）', () => {
    actions.setTool('taxiway');
    expect(key('l')).toBe(true);
    expect(state().options.taxiWidth).toBe('L');
    expect(Object.values(state().history.present.taxiways).every((e) => e.widthClass === 'M')).toBe(true);
  });

  // 注: プロパティパネルのボタン（prop-widthClassRoute）は、同じ setTaxiwayRouteWidth を
  // applyOp 経由で呼ぶだけの薄い導線で、区間数 N は taxiwayRouteEdges の戻り値そのもの。
  // zustand の SSR スナップショットは初期状態を返すため renderToString では選択状態を
  // 再現できず、パネルの描画テストは置かない（既存の shell 系テストも props 渡しの節だけを描画している）。
});
