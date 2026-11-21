/**
 * 建設画面の軽量化（性能改善 §3.6）:
 * - computeOp のメモ化: 同一入力では同一結果オブジェクトを返し、入力が変われば再計算する（意味不変）。
 * - layoutCapabilities の同一性キャッシュ: 同一レイアウトでは同一配列、結果は従来計算と一致。
 * - ゴースト判定の限定: プレビュー中のゴースト枠は配置操作の成否（緑）だけで決まり、
 *   接続などの診断はプレビュー中に付けない。
 * - 境界での全量検証: 配置を確定すると、全量解析がその診断（STAND_NOT_CONNECTED）を従来どおり出す。
 * - ラベルのツール連動限定: 配置ツール使用中は対象カテゴリのラベルだけが使われる。
 *
 * Pixi の Graphics/Text は最小限の DOM スタブで動かす（描画結果には影響しない）。
 */
import { describe, expect, it } from 'vitest';

class FakeCanvas {
  width = 0;
  height = 0;
  style: Record<string, string> = {};
  getContext(kind: string): unknown {
    if (kind !== '2d') return null;
    return {
      canvas: this,
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => undefined,
      measureText: (t: string) => ({ width: t.length * 6 }),
      fillText: () => undefined,
      drawImage: () => undefined,
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    };
  }
  toDataURL(): string {
    return '';
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}
(globalThis as Record<string, unknown>).HTMLCanvasElement = FakeCanvas;
(globalThis as Record<string, unknown>).HTMLImageElement = class {};
(globalThis as Record<string, unknown>).HTMLVideoElement = class {};
(globalThis as Record<string, unknown>).ImageData = class {
  data = new Uint8ClampedArray(4);
  width = 1;
  height = 1;
};
(globalThis as Record<string, unknown>).window = {
  devicePixelRatio: 1,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
(globalThis as Record<string, unknown>).document = {
  createElement: (tag: string) => (tag === 'canvas' ? new FakeCanvas() : { style: {} }),
  createElementNS: (_ns: string, tag: string) => (tag === 'canvas' ? new FakeCanvas() : { style: {} }),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  body: { appendChild: () => undefined },
};
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', gpu: undefined }, configurable: true });

import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createHistory } from '../../src/core/editor/history';
import { placeStand, cloneLayout } from '../../src/core/layout/operations';
import { analyzeLayout } from '../../src/core/validation/validate';
import { layoutCapabilities } from '../../src/core/capability';
import { computeOp, computePreview } from '../../src/editor/tools';
import { applyOp, editorStore, getAnalysis, DEFAULT_OVERLAYS, type EditorState } from '../../src/editor/store';
import { createSandboxCompany } from '../../src/core/economy/company';
import { COLOR } from '../../src/render/colors';
import type { AirportLayout } from '../../src/core/model/types';
import type { Tile } from '../../src/core/geometry/vec';

type PreviewStateArg = Parameters<typeof computeOp>[0];

function previewState(layout: AirportLayout, patch: Record<string, unknown>): PreviewStateArg {
  const base = editorStore.getState();
  return {
    tool: 'select',
    options: base.options,
    hover: null,
    hoverW: null,
    draft: null,
    history: createHistory(layout),
    interiorLevel: 0,
    ...patch,
  } as PreviewStateArg;
}

/** サンプル空港で「置けるが誘導路に接続していない」スポット候補タイルを探す */
function remoteStandTile(layout: AirportLayout): Tile {
  for (const cand of [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 2, y: 4 }, { x: 6, y: 2 }, { x: 2, y: 6 }]) {
    const placed = placeStand(layout, cand, 'M', 0);
    if (!placed.ok) continue;
    const a = analyzeLayout(placed.layout);
    const id = placed.created[0]!;
    if ((a.byTarget[id] ?? []).some((i) => i.code === 'STAND_NOT_CONNECTED' && i.severity === 'error')) return cand;
  }
  throw new Error('候補タイルが見つからない');
}

describe('建設画面の軽量化（§3.6）', () => {
  it('computeOp は同一入力で同一結果を返し、ホバーが変われば再計算する', () => {
    const layout = createSampleAirport();
    const tile = remoteStandTile(layout);
    const s1 = previewState(layout, { tool: 'stand', hover: tile });
    const r1 = computeOp(s1);
    expect(r1?.result.ok).toBe(true);
    // 別オブジェクトでも入力が同一なら同じ結果オブジェクト（＝再計算していない）
    const s2 = previewState(layout, { tool: 'stand', hover: { ...tile } });
    expect(computeOp(s2)).toBe(r1);
    expect(computePreview(s2)?.result).toBe(r1!.result);
    // ホバーが変われば再計算される（結果オブジェクトが変わる）が、内容は正しい
    const s3 = previewState(layout, { tool: 'stand', hover: { x: tile.x + 6, y: tile.y } });
    const r3 = computeOp(s3);
    expect(r3).not.toBe(r1);
    expect(r3?.result.ok).toBe(true);
    // キャッシュが別の入力で上書きされた後でも、元の入力は正しく再計算される
    const r1b = computeOp(s1);
    expect(r1b?.result.ok).toBe(true);
    if (r1b?.result.ok && r1?.result.ok) {
      expect(Object.keys(r1b.result.layout.stands).length).toBe(Object.keys(r1.result.layout.stands).length);
    }
  });

  it('layoutCapabilities は同一レイアウトで同一配列を返し、内容は従来計算と一致する', () => {
    const layout = createSampleAirport();
    const a = layoutCapabilities(layout);
    const b = layoutCapabilities(layout);
    expect(b).toBe(a);
    expect(a.length).toBe(Object.keys(layout.facilities).length);
    // 別レイアウト（複製）では再計算され、内容は一致する
    const clone = cloneLayout(layout);
    const c = layoutCapabilities(clone);
    expect(c).not.toBe(a);
    expect(c.map((r) => [r.subjectId, r.theoretical, r.effective])).toEqual(a.map((r) => [r.subjectId, r.theoretical, r.effective]));
  });

  it('プレビュー中のゴースト枠は緑（操作の成否）のみで、確定すると全量解析が診断を出す', async () => {
    const { MapRenderer } = await import('../../src/render/MapRenderer');
    const layout = createSampleAirport();
    const tile = remoteStandTile(layout);
    const base = editorStore.getState();
    const state = {
      ...base,
      history: createHistory(layout),
      mode: 'build' as const,
      ops: null,
      camera: { x: 0, y: 0, zoom: 3 },
      viewSize: { w: 1600, h: 900 },
      mapLevel: 'all' as const,
      overlays: { ...DEFAULT_OVERLAYS },
      tool: 'stand' as const,
      hover: tile,
      hoverW: null,
      draft: null,
      selection: null,
    } as unknown as EditorState;

    const preview = computePreview(state);
    expect(preview?.result.ok).toBe(true);
    const ghostId = preview!.ghostIds[0]!;

    const renderer = new MapRenderer();
    const rr = renderer as unknown as { outline: (g: unknown, l: unknown, id: string, color: number, w: number) => void };
    const calls: { id: string; color: number }[] = [];
    const orig = rr.outline;
    rr.outline = function (g: unknown, l: unknown, id: string, color: number, w: number) {
      calls.push({ id, color });
      return orig.call(renderer, g, l, id, color, w);
    };
    renderer.draw(state);
    const ghostCalls = calls.filter((c) => c.id === ghostId);
    expect(ghostCalls.length).toBeGreaterThan(0);
    // 接続していないスポットでも、プレビュー中は診断で赤くしない（緑のみ）
    expect(ghostCalls.every((c) => c.color === COLOR.ghostOk)).toBe(true);
    expect(ghostCalls.some((c) => c.color === COLOR.ghostBad)).toBe(false);

    // 境界: 確定すると実レイアウトになり、全量解析が STAND_NOT_CONNECTED を出す
    editorStore.setState({
      history: createHistory(layout),
      company: createSandboxCompany(),
      selection: null,
      tool: 'select',
      draft: null,
      hover: null,
      hoverW: null,
      mode: 'build',
    } as Partial<EditorState>);
    const op = computeOp(previewState(editorStore.getState().history.present, { tool: 'stand', hover: tile }));
    if (!op?.result.ok) throw new Error('配置操作が成立しない');
    expect(applyOp(op.result)).toBe(true);
    const present = editorStore.getState().history.present;
    const newStandId = op.result.created[0]!;
    const analysis = getAnalysis(present);
    expect((analysis.byTarget[newStandId] ?? []).some((i) => i.code === 'STAND_NOT_CONNECTED' && i.severity === 'error')).toBe(true);
  });

  it('ラベルはツール連動で対象カテゴリだけが使われる', async () => {
    const { MapRenderer } = await import('../../src/render/MapRenderer');
    const layout = createSampleAirport();
    // 名前を付けた代表エンティティを用意する
    const stand = Object.values(layout.stands)[0]!;
    stand.name = 'ST1';
    const fac = Object.values(layout.facilities).find((f) => f.kind !== 'gate' && !f.parentFacilityId)!;
    fac.name = 'FAC1';
    const edge = Object.values(layout.taxiways).find((e) => layout.taxiNodes[e.from] && layout.taxiNodes[e.to])!;
    edge.name = 'A';
    const node = layout.taxiNodes[edge.from]!;
    node.name = 'N1';

    const base = editorStore.getState();
    const mkState = (tool: EditorState['tool']) =>
      ({
        ...base,
        history: createHistory(layout),
        mode: 'build' as const,
        ops: null,
        camera: { x: Math.max(0, stand.origin.x - 20), y: Math.max(0, stand.origin.y - 20), zoom: 9 },
        viewSize: { w: 1600, h: 900 },
        mapLevel: 'all' as const,
        overlays: { ...DEFAULT_OVERLAYS },
        tool,
        hover: null,
        hoverW: null,
        draft: null,
        selection: null,
      }) as unknown as EditorState;

    const usedKeys = (tool: EditorState['tool']): Set<string> => {
      const renderer = new MapRenderer();
      renderer.draw(mkState(tool));
      return new Set((renderer as unknown as { usedTexts: Set<string> }).usedTexts);
    };

    const all = usedKeys('select');
    expect([...all].some((k) => k.startsWith('std:'))).toBe(true);
    expect([...all].some((k) => k.startsWith('fac:'))).toBe(true);
    expect([...all].some((k) => k.startsWith('tn:'))).toBe(true);
    expect([...all].some((k) => k.startsWith('twy:'))).toBe(true);

    const twy = usedKeys('taxiway');
    expect([...twy].some((k) => k.startsWith('twy:'))).toBe(true);
    expect([...twy].some((k) => k.startsWith('tn:'))).toBe(true);
    expect([...twy].some((k) => k.startsWith('std:'))).toBe(false);
    expect([...twy].some((k) => k.startsWith('fac:'))).toBe(false);

    const facTool = usedKeys('facility:terminal');
    expect([...facTool].some((k) => k.startsWith('fac:'))).toBe(true);
    expect([...facTool].some((k) => k.startsWith('std:'))).toBe(false);
    expect([...facTool].some((k) => k.startsWith('twy:'))).toBe(false);
    expect([...facTool].some((k) => k.startsWith('tn:'))).toBe(false);
  });
});
