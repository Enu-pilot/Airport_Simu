/**
 * 第6弾（描画の軽量化）: MapRenderer の静的レイヤキャッシュの検証。
 *
 * - 視覚同等性: キャッシュ構築（カリング全域化）の命令列が、従来方式
 *   （表示範囲＝敷地全体のカメラで drawGrid + drawLayout を直接描く）の命令列と一致する。
 *   カリングは画面外分を落とすだけなので、全体が見える条件では従来と同一になる。
 * - キャッシュ挙動: パンでは再構築されず、zoom・レイアウト・表示条件の変更で再構築される。
 *
 * Pixi の Graphics 命令発行は DOM なしでも動くが、Text と地形テクスチャ生成が
 * 最小限の DOM API を要求するため、ここでスタブを入れる（描画結果には影響しない）。
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

/** Graphics 命令列を比較可能な文字列にする（テクスチャ参照や循環はタグに落とす） */
function serializeInstructions(gfx: unknown): string {
  const ctx = (gfx as { context: { instructions: unknown[] } }).context;
  const seen = new WeakSet<object>();
  const sanitize = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[ref]';
    seen.add(v);
    const name = (v as { constructor?: { name?: string } }).constructor?.name;
    if (name === 'Texture') return '[texture]';
    if (Array.isArray(v)) return v.map(sanitize);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'uid' || k === '_uid') continue;
      out[k] = sanitize(val);
    }
    return out;
  };
  return JSON.stringify(sanitize(ctx.instructions));
}

describe('MapRenderer 静的レイヤキャッシュ（第6弾）', () => {
  it('命令列が従来方式（全体表示）と一致し、パンで再構築されず、条件変更で再構築される', async () => {
    const { loadFixture } = await import('../golden/io');
    const { editorStore, DEFAULT_OVERLAYS, getAnalysis } = await import('../../src/editor/store');
    const { createHistory } = await import('../../src/core/editor/history');
    const { analyzeLayout } = await import('../../src/core/validation/validate');
    const { MapRenderer } = await import('../../src/render/MapRenderer');
    void analyzeLayout;

    const layout = loadFixture('sample');
    const site = layout.site;
    const base = editorStore.getState();
    const viewSize = { w: 1600, h: 1200 };
    const wholeZoom = Math.min(viewSize.w / site.width, viewSize.h / site.height);
    const mkState = (over: Record<string, unknown> = {}) => ({
      ...base,
      history: createHistory(layout),
      mode: 'build' as const,
      ops: null,
      camera: { x: 0, y: 0, zoom: wholeZoom },
      viewSize,
      mapLevel: 'all' as const,
      overlays: { ...DEFAULT_OVERLAYS },
      tool: 'select' as const,
      ...over,
    });

    // --- 同等性: 新方式（draw 経由・キャッシュ構築） vs 従来方式（直接描画） ---
    const a = new MapRenderer();
    a.draw(mkState() as never);
    const streamA = serializeInstructions((a as unknown as Record<string, unknown>)['g']);

    const b = new MapRenderer();
    const br = b as unknown as Record<string, unknown>;
    const analysis = getAnalysis(layout);
    br['zoom'] = wholeZoom;
    br['mapLevel'] = 'all';
    br['view'] = { x0: 0, y0: 0, x1: viewSize.w / wholeZoom, y1: viewSize.h / wholeZoom };
    (br['g'] as { clear: () => void }).clear();
    (b as unknown as { drawGrid: (...args: unknown[]) => void }).drawGrid({ x: 0, y: 0, zoom: wholeZoom }, viewSize, site);
    (b as unknown as { drawLayout: (...args: unknown[]) => void }).drawLayout(layout, analysis, mkState());
    const streamB = serializeInstructions(br['g']);
    expect(streamA).toBe(streamB);
    expect(streamA.length).toBeGreaterThan(1000);

    // --- パンでは再構築されない（命令列も不変） ---
    const ar = a as unknown as Record<string, unknown>;
    let layoutCalls = 0;
    let gridCalls = 0;
    const origLayout = ar['drawLayout'] as (...args: unknown[]) => void;
    const origGrid = ar['drawGrid'] as (...args: unknown[]) => void;
    ar['drawLayout'] = function (...args: unknown[]) {
      layoutCalls++;
      return origLayout.apply(a, args);
    };
    ar['drawGrid'] = function (...args: unknown[]) {
      gridCalls++;
      return origGrid.apply(a, args);
    };
    a.draw(mkState({ camera: { x: 5, y: 3, zoom: wholeZoom } }) as never);
    expect(layoutCalls).toBe(0);
    expect(gridCalls).toBe(0);
    expect(serializeInstructions(ar['g'])).toBe(streamA);

    // --- zoom が変われば再構築される ---
    a.draw(mkState({ camera: { x: 0, y: 0, zoom: wholeZoom * 2 } }) as never);
    expect(layoutCalls).toBe(1);

    // --- レイアウトが変われば再構築される ---
    const layout2 = structuredClone(layout);
    a.draw(mkState({ history: createHistory(layout2), camera: { x: 0, y: 0, zoom: wholeZoom * 2 } }) as never);
    expect(layoutCalls).toBe(2);

    // --- 表示条件（ネットワーク表示）が変われば再構築される ---
    a.draw(
      mkState({
        history: createHistory(layout2),
        camera: { x: 0, y: 0, zoom: wholeZoom * 2 },
        overlays: { ...DEFAULT_OVERLAYS, network: true },
      }) as never,
    );
    expect(layoutCalls).toBe(3);
  }, 120_000);
});
