import { describe, expect, it } from 'vitest';
import { actions, editorStore } from '../../src/editor/store';
import { hourlyMovements } from '../../src/ui/shell/Timeline';

describe('UIデザイン更新 第1段階: レンズ基盤', () => {
  it('レンズの初期値は build で、setLens で切り替わる（保存データには触らない）', () => {
    expect(editorStore.getState().lens).toBe('build');
    actions.setLens('manage');
    expect(editorStore.getState().lens).toBe('manage');
    actions.setLens('operate');
    expect(editorStore.getState().lens).toBe('operate');
    actions.setLens('build');
    expect(editorStore.getState().lens).toBe('build');
  });

  it('同じレンズへの setLens は状態を変えない', () => {
    const before = editorStore.getState();
    actions.setLens('build');
    expect(editorStore.getState()).toBe(before);
  });
});

describe('UIデザイン更新 第1段階: タイムライン波形', () => {
  it('到着・出発を時間帯ごとの回数に集計する', () => {
    const wave = hourlyMovements([
      { arrivalAt: 7 * 3600 + 600, departureAt: 8 * 3600 },
      { arrivalAt: 7 * 3600 + 1800, departureAt: 23 * 3600 + 3599 },
    ]);
    expect(wave).toHaveLength(24);
    expect(wave[7]).toBe(2);
    expect(wave[8]).toBe(1);
    expect(wave[23]).toBe(1);
    expect(wave.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('便がなければ全時間帯 0', () => {
    expect(hourlyMovements([]).every((n) => n === 0)).toBe(true);
  });

  it('範囲外の時刻は端の時間帯に丸める', () => {
    const wave = hourlyMovements([{ arrivalAt: -60, departureAt: 25 * 3600 }]);
    expect(wave[0]).toBe(1);
    expect(wave[23]).toBe(1);
  });
});
