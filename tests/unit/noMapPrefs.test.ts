import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editorStore, setOpsPrefs } from '../../src/editor/store';

/**
 * 地図なしモードの表示設定（opsPrefs.noMap）: 既定は地図あり（false）で、
 * 切替は opsPrefs の流儀どおり localStorage（skyport.opsPrefs.v1）に保存される。
 * プロジェクトデータには含まれない UI 設定であることの確認も兼ねる。
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
  setOpsPrefs({ noMap: false });
});

afterEach(() => {
  setOpsPrefs({ noMap: false });
  globalThis.localStorage = original as Storage;
});

describe('地図なしモードの設定保存', () => {
  it('既定は地図あり（noMap = false）', () => {
    expect(editorStore.getState().opsPrefs.noMap).toBe(false);
  });

  it('切替が store と localStorage の両方に反映され、他の設定を壊さない', () => {
    const before = editorStore.getState().opsPrefs;
    setOpsPrefs({ noMap: true });
    expect(editorStore.getState().opsPrefs.noMap).toBe(true);
    const saved = JSON.parse(backing.get(KEY)!) as Record<string, unknown>;
    expect(saved.noMap).toBe(true);
    expect(saved.pauseAtDayClose).toBe(before.pauseAtDayClose);
    expect(saved.skipAutoStop).toBe(before.skipAutoStop);
    setOpsPrefs({ noMap: false });
    expect(editorStore.getState().opsPrefs.noMap).toBe(false);
    expect((JSON.parse(backing.get(KEY)!) as Record<string, unknown>).noMap).toBe(false);
  });
});
