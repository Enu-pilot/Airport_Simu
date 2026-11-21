import { beforeEach, describe, expect, it } from 'vitest';
import { RUNWAY_WIDTH_CLASS } from '../../src/core/model/catalog';
import { floorDisplay } from '../../src/core/model/levels';
import { FLOOR_SELECTOR_LEVELS } from '../../src/i18n/ja';
import { createHistory } from '../../src/core/editor/history';
import { actions, editorStore, DEFAULT_OVERLAYS } from '../../src/editor/store';
import { onKeyDown } from '../../src/editor/input';
import {
  ALL_LAYERS_KEY,
  BUILD_OVERLAY_TOGGLES,
  LEVEL_FOR_DIGIT_KEY,
  OPERATE_OVERLAY_TOGGLES,
  digitKeyForLevel,
  keyForOverlayToggle,
  levelForDigitKey,
  overlayToggleForKey,
  runwayWidthForKey,
  sizeClassForKey,
  sizeKeyOf,
  sizeOptionForTool,
  sizeStageIndex,
  toolForKey,
  type SizeKey,
} from '../../src/editor/shortcuts';
import { emptyLayout } from './helpers';

/**
 * キーボードショートカット（docs/06 §4.1.1）: 数字キー=表示階、S/M/L/F=サイズ段階、
 * ツール切替・全レイヤ・表示レイヤ切替の対応と、既存キーとの非競合を固定する。
 */

describe('数字キー → 表示階', () => {
  it('8=B3F・9=B2F・0=B1F・1=1F・2=2F・3=3F・4=4F の連続配置', () => {
    expect(LEVEL_FOR_DIGIT_KEY).toEqual({ '8': -3, '9': -2, '0': -1, '1': 0, '2': 1, '3': 2, '4': 3 });
    expect(levelForDigitKey('8')).toBe(-3);
    expect(levelForDigitKey('9')).toBe(-2);
    expect(levelForDigitKey('0')).toBe(-1);
    expect(levelForDigitKey('1')).toBe(0);
    expect(levelForDigitKey('2')).toBe(1);
    expect(levelForDigitKey('3')).toBe(2);
    expect(levelForDigitKey('4')).toBe(3);
  });

  it('対応する階はすべて階ボタン（B3〜4F）の範囲内で、建物内階の表記と一致する', () => {
    for (const [digit, level] of Object.entries(LEVEL_FOR_DIGIT_KEY)) {
      expect(FLOOR_SELECTOR_LEVELS).toContain(level);
      expect(digitKeyForLevel(level)).toBe(digit);
    }
    expect(floorDisplay(levelForDigitKey('8')!).building).toBe('B3F');
    expect(floorDisplay(levelForDigitKey('0')!).building).toBe('B1F');
    expect(floorDisplay(levelForDigitKey('1')!).building).toBe('1F');
    expect(floorDisplay(levelForDigitKey('4')!).building).toBe('4F');
  });

  it('5〜7 と数字以外は割り当てなし', () => {
    for (const k of ['5', '6', '7', 'a', ' ', '']) expect(levelForDigitKey(k)).toBeNull();
    expect(digitKeyForLevel(-4)).toBeNull();
    expect(digitKeyForLevel(4)).toBeNull();
  });
});

describe('S/M/L/F → サイズ段階', () => {
  it('sizeKeyOf は s/m/l/f だけを受ける（大文字は input 側で小文字化される前提）', () => {
    expect(sizeKeyOf('s')).toBe('s');
    expect(sizeKeyOf('m')).toBe('m');
    expect(sizeKeyOf('l')).toBe('l');
    expect(sizeKeyOf('f')).toBe('f');
    expect(sizeKeyOf('S')).toBeNull();
    expect(sizeKeyOf('x')).toBeNull();
  });

  it('一般規則: S は最小・F は最大・M/L は 1/3・2/3 の位置（切り上げ）', () => {
    const keys: SizeKey[] = ['s', 'm', 'l', 'f'];
    // 段階数ごとの期待表
    expect(keys.map((k) => sizeStageIndex(k, 1))).toEqual([0, 0, 0, 0]);
    expect(keys.map((k) => sizeStageIndex(k, 2))).toEqual([0, 1, 1, 1]);
    expect(keys.map((k) => sizeStageIndex(k, 3))).toEqual([0, 1, 2, 2]);
    expect(keys.map((k) => sizeStageIndex(k, 4))).toEqual([0, 1, 2, 3]);
    expect(keys.map((k) => sizeStageIndex(k, 5))).toEqual([0, 2, 3, 4]);
    // 任意の段階数で単調・範囲内・両端が固定される
    for (let n = 1; n <= 9; n++) {
      const idx = keys.map((k) => sizeStageIndex(k, n));
      expect(idx[0]).toBe(0);
      expect(idx[3]).toBe(n - 1);
      for (let i = 0; i < 4; i++) {
        expect(idx[i]!).toBeGreaterThanOrEqual(0);
        expect(idx[i]!).toBeLessThanOrEqual(n - 1);
        if (i > 0) expect(idx[i]!).toBeGreaterThanOrEqual(idx[i - 1]!);
      }
    }
  });

  it('SizeClass（3段階）では S/M/L が 1対1、F は最大（L）の別名', () => {
    expect(sizeClassForKey('s')).toBe('S');
    expect(sizeClassForKey('m')).toBe('M');
    expect(sizeClassForKey('l')).toBe('L');
    expect(sizeClassForKey('f')).toBe('L');
  });

  it('滑走路の舗装幅（30/45/60m）は級の対応と一致する', () => {
    expect(runwayWidthForKey('s')).toBe(30);
    expect(runwayWidthForKey('m')).toBe(45);
    expect(runwayWidthForKey('l')).toBe(60);
    expect(runwayWidthForKey('f')).toBe(60);
    for (const k of ['s', 'm', 'l', 'f'] as SizeKey[]) {
      expect(RUNWAY_WIDTH_CLASS[runwayWidthForKey(k)]).toBe(sizeClassForKey(k));
    }
  });

  it('ツール文脈: 誘導路=幅・スポット=サイズ・滑走路=舗装幅、それ以外は対象外', () => {
    expect(sizeOptionForTool('taxiway', 'l')).toEqual({ option: 'taxiWidth', value: 'L' });
    expect(sizeOptionForTool('stand', 's')).toEqual({ option: 'standSize', value: 'S' });
    expect(sizeOptionForTool('runway', 'm')).toEqual({ option: 'runwayWidth', value: 45 });
    for (const tool of ['select', 'road', 'land', 'pbb', 'agt', 'facility:terminal', 'facility:apron', 'area:waiting'] as const) {
      expect(sizeOptionForTool(tool, 'l')).toBeNull();
    }
  });
});

describe('切り替え系の対応表と非競合', () => {
  it('ツール切替: T=誘導路・P=スポットのみ', () => {
    expect(toolForKey('t')).toBe('taxiway');
    expect(toolForKey('p')).toBe('stand');
    expect(toolForKey('v')).toBeNull(); // V（選択）は既存の割当て
    expect(toolForKey('r')).toBeNull(); // R（回転）は既存の割当て
  });

  it('レイヤ切替: 建設と運航で共通分が一致し、運航だけ地図注記が増える', () => {
    for (const t of BUILD_OVERLAY_TOGGLES) {
      expect(overlayToggleForKey('operate', t.key)).toEqual(t);
      expect(keyForOverlayToggle('build', t.overlay)).toBe(t.key);
    }
    expect(overlayToggleForKey('operate', 'f')?.overlay).toBe('flightNames');
    expect(overlayToggleForKey('operate', 'p')?.overlay).toBe('busPax');
    expect(overlayToggleForKey('operate', 'k')?.overlay).toBe('cargoCounts');
    expect(overlayToggleForKey('operate', 'd')?.overlay).toBe('daylight');
    // 建設モードでは運航中の地図注記にキーを置かない
    for (const k of ['f', 'p', 'k', 'd']) {
      if (k === 'p') continue; // P は建設ではスポットツール（モード別割当てのため対象外）
      expect(overlayToggleForKey('build', k)).toBeNull();
    }
    expect(keyForOverlayToggle('build', 'labels')).toBeNull(); // ラベルは見送り（L はサイズ専用）
  });

  it('新規キーは既存キー・相互に衝突しない', () => {
    const existingBuild = [' ', 'r', 'v', 'escape', 'enter', 'delete', 'backspace', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
    const buildKeys = [
      ...Object.keys(LEVEL_FOR_DIGIT_KEY),
      ...(['s', 'm', 'l', 'f'] as SizeKey[]),
      ALL_LAYERS_KEY,
      ...BUILD_OVERLAY_TOGGLES.map((t) => t.key),
      ...(['t', 'p'] as const),
    ];
    for (const k of buildKeys) expect(existingBuild).not.toContain(k);
    expect(new Set(buildKeys).size).toBe(buildKeys.length); // 役割をまたいだ重複なし
    const operateKeys = OPERATE_OVERLAY_TOGGLES.map((t) => t.key);
    expect(new Set(operateKeys).size).toBe(operateKeys.length);
    for (const k of operateKeys) {
      expect([' ', 'escape', '1', '2', '3', '4', '5']).not.toContain(k); // 運航の既存キー（Space・速度・Esc）と衝突しない
    }
  });
});

describe('入力（ストア経由）', () => {
  beforeEach(() => {
    editorStore.setState({
      history: createHistory(emptyLayout(200, 200)),
      selection: null,
      draft: null,
      mode: 'build',
      tool: 'select',
      overlays: { ...DEFAULT_OVERLAYS },
      charges: { past: [], future: [] },
    });
    actions.setOption('taxiWidth', 'M');
    actions.setOption('standSize', 'M');
    actions.setOption('runwayWidth', 45);
    actions.setInteriorLevel(0);
  });
  const state = () => editorStore.getState();
  const key = (k: string, mods: { ctrl?: boolean; shift?: boolean } = {}) =>
    onKeyDown({ key: k, ctrl: !!mods.ctrl, shift: !!mods.shift });

  it('数字キーで表示階が変わり、地図階層と内部表示も同期する（階ボタンと同じ）', () => {
    expect(key('2')).toBe(true);
    expect(state().interiorLevel).toBe(1);
    expect(state().mapLevel).toBe(1);
    expect(state().overlays.interior).toBe(true);
    expect(key('8')).toBe(true);
    expect(state().interiorLevel).toBe(-3);
    expect(key('0')).toBe(true);
    expect(state().interiorLevel).toBe(-1);
  });

  it('割り当てのない数字（5）は何もしない', () => {
    expect(key('5')).toBe(false);
    expect(state().interiorLevel).toBe(0);
  });

  it('A で全レイヤ表示になり、配置先の階（内部の表示階）は維持される', () => {
    actions.setInteriorLevel(2);
    expect(key('a')).toBe(true);
    expect(state().mapLevel).toBe('all');
    expect(state().interiorLevel).toBe(2);
  });

  it('サイズキー: 誘導路ツールでは幅、スポットではサイズ、滑走路では舗装幅が変わる', () => {
    actions.setTool('taxiway');
    expect(key('l')).toBe(true);
    expect(state().options.taxiWidth).toBe('L');
    expect(key('f')).toBe(true);
    expect(state().options.taxiWidth).toBe('L'); // F は最大の別名
    expect(key('s')).toBe(true);
    expect(state().options.taxiWidth).toBe('S');

    actions.setTool('stand');
    expect(key('m')).toBe(true);
    expect(state().options.standSize).toBe('M');

    actions.setTool('runway');
    expect(key('s')).toBe(true);
    expect(state().options.runwayWidth).toBe(30);
    expect(key('f')).toBe(true);
    expect(state().options.runwayWidth).toBe(60);
  });

  it('サイズを持たないツールではサイズキーは素通りする', () => {
    actions.setTool('select');
    expect(key('s')).toBe(false);
    expect(key('l')).toBe(false);
    expect(state().options.taxiWidth).toBe('M');
  });

  it('Ctrl 併用時はショートカットを発動しない（ブラウザ・既存の Ctrl 系を優先）', () => {
    actions.setTool('taxiway');
    expect(key('s', { ctrl: true })).toBe(false);
    expect(state().options.taxiWidth).toBe('M');
    expect(key('2', { ctrl: true })).toBe(false);
    expect(state().interiorLevel).toBe(0);
    expect(key('g', { ctrl: true })).toBe(false);
    expect(state().overlays.grid).toBe(DEFAULT_OVERLAYS.grid);
  });

  it('ツール切替: T で誘導路、P でスポット、V で選択（既存）', () => {
    expect(key('t')).toBe(true);
    expect(state().tool).toBe('taxiway');
    expect(key('p')).toBe(true);
    expect(state().tool).toBe('stand');
    expect(key('v')).toBe(true);
    expect(state().tool).toBe('select');
  });

  it('レイヤ切替: G でグリッド、N で論理ネットワークがトグルする', () => {
    const grid0 = state().overlays.grid;
    expect(key('g')).toBe(true);
    expect(state().overlays.grid).toBe(!grid0);
    expect(key('g')).toBe(true);
    expect(state().overlays.grid).toBe(grid0);
    const net0 = state().overlays.network;
    expect(key('n')).toBe(true);
    expect(state().overlays.network).toBe(!net0);
  });

  it('運航モード: 数字は速度（既存）のまま、F/K で便名・貨物数がトグルする', () => {
    editorStore.setState({ mode: 'operate' });
    const fn0 = state().overlays.flightNames;
    expect(key('f')).toBe(true);
    expect(state().overlays.flightNames).toBe(!fn0);
    const cc0 = state().overlays.cargoCounts;
    expect(key('k')).toBe(true);
    expect(state().overlays.cargoCounts).toBe(!cc0);
    // 建設専用の割当て（A=全レイヤ、T=ツール）は運航では発動しない
    expect(key('a')).toBe(false);
    expect(key('t')).toBe(false);
  });
});
