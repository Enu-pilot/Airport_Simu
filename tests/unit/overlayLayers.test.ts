import { afterEach, describe, expect, it } from 'vitest';
import { actions, DEFAULT_OVERLAYS, editorStore, loadOverlays, saveOverlays, type Overlays } from '../../src/editor/store';

/**
 * 表示レイヤ選択の復活（2026-11-20 PO 要望）:
 * - 既定値は従来の初期表示と同一（便名・バス人数は表示、貨物数は従来表示が無いため OFF）
 * - 設定は localStorage（skyport.overlays.v1）に保存し、欠けた項目・壊れた値は既定値に寄せる（後方互換）
 */

const KEY = 'skyport.overlays.v1';

function stubLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
  const map = new Map(Object.entries(initial));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
  return map;
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  editorStore.setState({ overlays: loadOverlays() });
});

describe('表示レイヤの既定値', () => {
  it('従来の8項目の既定が変わっていない', () => {
    expect(DEFAULT_OVERLAYS.grid).toBe(true);
    expect(DEFAULT_OVERLAYS.interior).toBe(false);
    expect(DEFAULT_OVERLAYS.buildable).toBe(false);
    expect(DEFAULT_OVERLAYS.network).toBe(false);
    expect(DEFAULT_OVERLAYS.issues).toBe(true);
    expect(DEFAULT_OVERLAYS.labels).toBe(true);
    expect(DEFAULT_OVERLAYS.congestion).toBe(false);
    expect(DEFAULT_OVERLAYS.daylight).toBe(true);
  });

  it('復活した3項目: 便名・バス人数は表示（従来どおり）、貨物数は OFF（初期表示を変えない）', () => {
    expect(DEFAULT_OVERLAYS.flightNames).toBe(true);
    expect(DEFAULT_OVERLAYS.busPax).toBe(true);
    expect(DEFAULT_OVERLAYS.cargoCounts).toBe(false);
  });

  it('localStorage が無い環境では既定値が返る', () => {
    expect(loadOverlays()).toEqual(DEFAULT_OVERLAYS);
  });
});

describe('表示レイヤの保存・読込（後方互換）', () => {
  it('保存した設定がそのまま読み戻せる', () => {
    stubLocalStorage();
    const custom: Overlays = { ...DEFAULT_OVERLAYS, network: true, flightNames: false, cargoCounts: true };
    saveOverlays(custom);
    expect(loadOverlays()).toEqual(custom);
  });

  it('一部の項目だけ保存された旧データは、欠けた項目が既定値で補われる', () => {
    stubLocalStorage({ [KEY]: JSON.stringify({ network: true, labels: false }) });
    const loaded = loadOverlays();
    expect(loaded.network).toBe(true);
    expect(loaded.labels).toBe(false);
    // 復活した3項目は旧データに無いので既定値
    expect(loaded.flightNames).toBe(DEFAULT_OVERLAYS.flightNames);
    expect(loaded.busPax).toBe(DEFAULT_OVERLAYS.busPax);
    expect(loaded.cargoCounts).toBe(DEFAULT_OVERLAYS.cargoCounts);
    expect(loaded.grid).toBe(DEFAULT_OVERLAYS.grid);
  });

  it('壊れた JSON・型の違う値は既定値に寄せる', () => {
    stubLocalStorage({ [KEY]: '{not json' });
    expect(loadOverlays()).toEqual(DEFAULT_OVERLAYS);
    stubLocalStorage({ [KEY]: JSON.stringify({ flightNames: 'yes', cargoCounts: 1 }) });
    const loaded = loadOverlays();
    expect(loaded.flightNames).toBe(DEFAULT_OVERLAYS.flightNames);
    expect(loaded.cargoCounts).toBe(DEFAULT_OVERLAYS.cargoCounts);
  });

  it('toggleOverlay で切り替えると保存される', () => {
    const map = stubLocalStorage();
    editorStore.setState({ overlays: { ...DEFAULT_OVERLAYS } });
    actions.toggleOverlay('cargoCounts');
    expect(editorStore.getState().overlays.cargoCounts).toBe(true);
    const saved = JSON.parse(map.get(KEY)!) as Overlays;
    expect(saved.cargoCounts).toBe(true);
    expect(saved.flightNames).toBe(DEFAULT_OVERLAYS.flightNames);
    actions.toggleOverlay('cargoCounts');
    expect(editorStore.getState().overlays.cargoCounts).toBe(false);
  });
});
