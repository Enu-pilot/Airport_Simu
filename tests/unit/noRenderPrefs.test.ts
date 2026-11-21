import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editorStore, setOpsPrefs } from '../../src/editor/store';

/**
 * 無描画運行モードの表示設定（opsPrefs.noRender、性能改善計画 第5弾）: 既定は描画あり（false）で、
 * 切替は opsPrefs の流儀どおり localStorage（skyport.opsPrefs.v1）に保存される。
 * 地図なしモード（noMap）とは独立した設定で、表示側では noRender が優先される。
 */
const KEY = 'skyport.opsPrefs.v1';
let original: Storage | undefined;
let backing: Map<string, string>;

beforeEach(() => {
  backing = new Map();
  original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  } as Storage;
  setOpsPrefs({ noRender: false, noMap: false });
});

afterEach(() => {
  setOpsPrefs({ noRender: false, noMap: false });
  globalThis.localStorage = original as Storage;
});

describe('無描画運行モードの設定保存', () => {
  it('既定は描画あり（noRender = false）', () => {
    expect(editorStore.getState().opsPrefs.noRender).toBe(false);
  });

  it('切替が store と localStorage の両方に反映され、他の設定を壊さない', () => {
    const before = editorStore.getState().opsPrefs;
    setOpsPrefs({ noRender: true });
    expect(editorStore.getState().opsPrefs.noRender).toBe(true);
    const saved = JSON.parse(backing.get(KEY)!) as Record<string, unknown>;
    expect(saved.noRender).toBe(true);
    expect(saved.pauseAtDayClose).toBe(before.pauseAtDayClose);
    expect(saved.skipAutoStop).toBe(before.skipAutoStop);
    expect(saved.noMap).toBe(before.noMap);
    setOpsPrefs({ noRender: false });
    expect(editorStore.getState().opsPrefs.noRender).toBe(false);
    expect((JSON.parse(backing.get(KEY)!) as Record<string, unknown>).noRender).toBe(false);
  });

  it('noMap とは独立に切り替わる（無描画を解除しても地図なしの選択は残る）', () => {
    setOpsPrefs({ noMap: true });
    setOpsPrefs({ noRender: true });
    expect(editorStore.getState().opsPrefs).toMatchObject({ noMap: true, noRender: true });
    setOpsPrefs({ noRender: false });
    expect(editorStore.getState().opsPrefs).toMatchObject({ noMap: true, noRender: false });
  });
});
