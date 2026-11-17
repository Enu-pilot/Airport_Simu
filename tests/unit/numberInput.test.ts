/**
 * 回帰: エスカレーター（階段・エレベーターも同じ）を選択すると画面全体がブラックアウトした。
 * capacityPerHour は未設定が正（運航では既定の縦移動能力を使う）だが、PropertiesPanel が
 * Number(props.capacityPerHour) = NaN を NumberInput に渡し、描画中の prev 比較が
 * NaN !== NaN で常に真になり setState が無限ループした（React #301 Too many re-renders）。
 * 画面での再現: サンプル空港のエスカレーターを選択する。
 */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { NumberInput } from '../../src/ui/fields';

const render = (value: number, min = 1, max = 100000): string =>
  renderToString(createElement(NumberInput, { value, min, max, onCommit: () => {} }));

describe('NumberInput', () => {
  it('通常の値はそのまま表示する', () => {
    expect(render(30)).toContain('value="30"');
    expect(render(0, 0)).toContain('value="0"');
  });

  it('未設定（NaN）を渡しても再描画ループにならず、空欄で表示する', () => {
    expect(() => render(Number(undefined))).not.toThrow();
    expect(render(Number(undefined))).toContain('value=""');
    expect(() => render(Number.POSITIVE_INFINITY)).not.toThrow();
  });

  it('サンプル空港のエスカレーターの capacityPerHour（未設定）でも描画できる', () => {
    const layout = createSampleAirport();
    const escalator = Object.values(layout.terminalAreas).find((a) => a.kind === 'escalator')!;
    expect(escalator.props.capacityPerHour).toBeUndefined();
    // PropertiesPanel が実際に渡す値
    expect(() => render(Number(escalator.props.capacityPerHour))).not.toThrow();
    expect(render(Number(escalator.props.travelSec))).toContain('value="30"');
  });
});
