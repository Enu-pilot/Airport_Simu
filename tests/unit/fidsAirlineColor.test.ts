import { describe, expect, it } from 'vitest';
import { fidsAirlineColor, hexToHsl } from '../../src/ui/operate/airlineColor';

/** '#rrggbb' を数値に戻して HSL で見る */
const hslOf = (css: string) => hexToHsl(parseInt(css.slice(1), 16));

describe('fidsAirlineColor（運行表の便名の航空会社カラー）', () => {
  it('濃い tail を持つ会社（NH）は明度を読みやすい範囲に寄せた色を返す', () => {
    const color = fidsAirlineColor('NH');
    expect(color).toBeDefined();
    expect(color).not.toBe('#0b3d91'); // 塗装の tail そのままではない
    const { h, s, l } = hslOf(color!);
    expect(h).toBeGreaterThanOrEqual(213);
    expect(h).toBeLessThanOrEqual(223); // tail 0x0b3d91 の色相（青）を保持
    expect(s).toBeGreaterThan(0.5);
    expect(l).toBeGreaterThanOrEqual(0.6);
    expect(l).toBeLessThanOrEqual(0.78);
  });

  it('白 tail＋色付き stripe の会社（JL）は stripe 由来の色を返す', () => {
    const color = fidsAirlineColor('JL');
    expect(color).toBeDefined();
    const { h, l } = hslOf(color!);
    expect(h).toBeGreaterThanOrEqual(350); // stripe 0xd9232e の赤
    expect(l).toBeGreaterThanOrEqual(0.6);
    expect(l).toBeLessThanOrEqual(0.78);
  });

  it('グレー tail の会社（OZ）は tail を読み飛ばして stripe の赤を使う', () => {
    const color = fidsAirlineColor('OZ');
    expect(color).toBeDefined();
    const { h } = hslOf(color!);
    expect(h).toBeLessThanOrEqual(3); // stripe 0xef4444 の色相は 0
  });

  it('LIVERIES 側の架空会社（SK）も tail の青を返す', () => {
    const color = fidsAirlineColor('SK');
    expect(color).toBeDefined();
    const { h, l } = hslOf(color!);
    expect(h).toBeGreaterThanOrEqual(215);
    expect(h).toBeLessThanOrEqual(232);
    expect(l).toBeGreaterThanOrEqual(0.6);
    expect(l).toBeLessThanOrEqual(0.78);
  });

  it('ほぼ黒の tail（SF）は明度を上げて返す', () => {
    const color = fidsAirlineColor('SF');
    expect(color).toBeDefined();
    const { l } = hslOf(color!);
    expect(l).toBeGreaterThanOrEqual(0.6);
    expect(l).toBeLessThanOrEqual(0.78);
  });

  it('不明な会社・airlineId なしは既定（undefined）', () => {
    expect(fidsAirlineColor('XX')).toBeUndefined();
    expect(fidsAirlineColor(null)).toBeUndefined();
    expect(fidsAirlineColor(undefined)).toBeUndefined();
    expect(fidsAirlineColor('')).toBeUndefined();
  });
});
