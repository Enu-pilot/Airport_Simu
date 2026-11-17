import { describe, expect, it } from 'vitest';
import { updateEntity, updateLayoutSettings } from '../../src/core/layout/operations';
import { checkTaxiFields, exportLayout, importLayout } from '../../src/core/io/serialize';
import { checkLayout } from '../../src/core/io/project';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { must } from './helpers';

/** フェーズ 2 の設定（区間ごとに進む地上走行）の操作・検証（plan §1.1・2-07）。 */
describe('updateLayoutSettings: taxiMode / taxiBlockTiles', () => {
  it('block を選ぶとキーが入り、full に戻すとキーが消える（従来データのバイト列に戻る）', () => {
    const base = createSampleAirport();
    const before = JSON.stringify(base);
    const a = must(updateLayoutSettings(base, { taxiMode: 'block' })).layout;
    expect(a.taxiMode).toBe('block');
    expect(a.taxiBlockTiles).toBeUndefined();
    const b = must(updateLayoutSettings(a, { taxiMode: 'full' })).layout;
    expect('taxiMode' in b).toBe(false);
    expect(JSON.stringify(b)).toBe(before);
  });

  it('既定の full を指定しても変化なし（NO_CHANGE）。キーは作られない', () => {
    const base = createSampleAirport();
    const r = updateLayoutSettings(base, { taxiMode: 'full' });
    expect(r.ok).toBe(false);
    expect('taxiMode' in base).toBe(false);
  });

  it('taxiBlockTiles: 4〜40 の整数だけ。10（既定）はキーを書かない。taxiMode を戻しても値が残る', () => {
    const base = createSampleAirport();
    const a = must(updateLayoutSettings(base, { taxiMode: 'block', taxiBlockTiles: 16 })).layout;
    expect(a.taxiBlockTiles).toBe(16);
    const b = must(updateLayoutSettings(a, { taxiMode: 'full' })).layout;
    expect(b.taxiBlockTiles).toBe(16);
    const c = must(updateLayoutSettings(b, { taxiBlockTiles: 10 })).layout;
    expect('taxiBlockTiles' in c).toBe(false);
    for (const v of [4, 40]) expect(must(updateLayoutSettings(base, { taxiBlockTiles: v })).layout.taxiBlockTiles).toBe(v);
    expect(updateLayoutSettings(base, { taxiBlockTiles: 10 }).ok).toBe(false); // NO_CHANGE
  });

  it('範囲外・非整数・不正な方式は INVALID_VALUE で、元は変わらない', () => {
    const base = createSampleAirport();
    for (const v of [3, 41, 0, -1, 10.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = updateLayoutSettings(base, { taxiBlockTiles: v });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('INVALID_VALUE');
    }
    const r = updateLayoutSettings(base, { taxiMode: 'zzz' as 'block' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INVALID_VALUE');
    expect('taxiMode' in base).toBe(false);
  });
});

describe('updateEntity: 誘導路の blockMaxAircraft', () => {
  const taxiwayId = (l: ReturnType<typeof createSampleAirport>) => Object.keys(l.taxiways).sort()[0]!;
  it('1〜10 の整数を設定でき、null で解除するとキーが消える', () => {
    const base = createSampleAirport();
    const id = taxiwayId(base);
    const a = must(updateEntity(base, id, { blockMaxAircraft: 3 })).layout;
    expect(a.taxiways[id]!.blockMaxAircraft).toBe(3);
    const b = must(updateEntity(a, id, { blockMaxAircraft: null })).layout;
    expect('blockMaxAircraft' in b.taxiways[id]!).toBe(false);
    expect(JSON.stringify(b)).toBe(JSON.stringify(base));
    expect(updateEntity(base, id, { blockMaxAircraft: null }).ok).toBe(false); // 元からない = NO_CHANGE
  });
  it('範囲外・非整数は INVALID_VALUE', () => {
    const base = createSampleAirport();
    const id = taxiwayId(base);
    for (const v of [0, 11, 2.5, '3', Number.NaN]) {
      const r = updateEntity(base, id, { blockMaxAircraft: v });
      expect(r.ok).toBe(false);
    }
  });
});

describe('checkTaxiFields / 読み込み検証', () => {
  it('従来のレイアウトは何も検出しない', () => {
    expect(checkTaxiFields(createSampleAirport(), 'レイアウト')).toEqual([]);
  });
  it('不正な値は日本語のエラーになり、レイアウトの読み込み（importLayout）も失敗する', () => {
    const l = createSampleAirport();
    const id = Object.keys(l.taxiways).sort()[0]!;
    const cases: [string, (x: Record<string, unknown>) => void, RegExp][] = [
      ['taxiMode', (x) => { x.taxiMode = 'full'; }, /taxiMode/],
      ['tiles 低', (x) => { x.taxiBlockTiles = 3; }, /taxiBlockTiles/],
      ['tiles 小数', (x) => { x.taxiBlockTiles = 10.5; }, /taxiBlockTiles/],
      ['tiles 文字', (x) => { x.taxiBlockTiles = '10'; }, /taxiBlockTiles/],
      ['上限 0', (x) => { (x.taxiways as Record<string, Record<string, unknown>>)[id]!.blockMaxAircraft = 0; }, /blockMaxAircraft/],
      ['上限 11', (x) => { (x.taxiways as Record<string, Record<string, unknown>>)[id]!.blockMaxAircraft = 11; }, /blockMaxAircraft/],
    ];
    for (const [, mutate, re] of cases) {
      const c = structuredClone(l) as unknown as Record<string, unknown>;
      mutate(c);
      expect(checkLayout(c).join('\n')).toMatch(re);
      expect(() => importLayout(exportLayout(c as unknown as typeof l))).toThrow(re);
    }
  });
  it('正しい設定は往復できる', () => {
    let l = createSampleAirport();
    l = must(updateLayoutSettings(l, { taxiMode: 'block', taxiBlockTiles: 12 })).layout;
    const id = Object.keys(l.taxiways).sort()[0]!;
    l = must(updateEntity(l, id, { blockMaxAircraft: 2 })).layout;
    expect(checkTaxiFields(l, 'x')).toEqual([]);
    expect(importLayout(exportLayout(l))).toEqual(l);
  });
});
