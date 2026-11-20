import type { CSSProperties } from 'react';
import { liveryOf } from '../../core/assets/registry';

/**
 * 運行表（FIDS）の便名に使う航空会社カラー（CSS の #rrggbb 文字列）。
 *
 * 塗装（livery）の tail → stripe の順にブランド色を選び、濃色背景（#070b10）でも
 * 読めるよう HSL の明度を 60〜78% に寄せる（色相と彩度は保持する）。
 * 白・ほぼ白・ほぼ無彩色（グレー系）しかない会社と、不明な会社・契約のない便
 * （airlineId が null）は undefined を返し、呼び出し側は CSS の既定色のままにする。
 */
export function fidsAirlineColor(airlineId: string | null | undefined): string | undefined {
  if (!airlineId) return undefined;
  const livery = liveryOf(airlineId);
  // 不明な会社は liveryOf が既定塗装（airlineId: null）を返すので、会社色なしとして扱う
  if (!livery.airlineId) return undefined;
  for (const hex of [livery.tail, livery.stripe]) {
    const color = readableBrandColor(hex);
    if (color) return color;
  }
  return undefined;
}

/**
 * 便名セル（.fids-num）に渡す style。会社色を CSS 変数 --fids-airline として渡し、
 * 色そのものは operate.css 側で解決する（欠航等の tone-bad の赤字は CSS の優先度で勝つ）。
 * 会社色がない便は undefined（従来の既定色のまま）。
 */
export function fidsNumStyle(airlineId: string | null | undefined): CSSProperties | undefined {
  const color = fidsAirlineColor(airlineId);
  return color ? ({ '--fids-airline': color } as CSSProperties) : undefined;
}

/** 16進カラー（0xrrggbb）を HSL に分解する（h: 0〜360、s/l: 0〜1） */
export function hexToHsl(hex: number): { h: number; s: number; l: number } {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

/** 濃色背景で読めるブランド色に直す。文字色に不適な色（無彩色・ほぼ白）は undefined */
function readableBrandColor(hex: number): string | undefined {
  const { h, s, l } = hexToHsl(hex);
  if (s < 0.15) return undefined; // グレー・白・黒などのほぼ無彩色はブランド色にしない
  if (l > 0.92) return undefined; // ほぼ白は読み飛ばす（次の候補を見る）
  const lightness = Math.min(0.78, Math.max(0.6, l));
  return hslToHex(h, s, lightness);
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const part = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}
