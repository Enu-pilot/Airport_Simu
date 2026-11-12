/**
 * 滑走路番号（Phase 12 S2）。
 *
 * 規則と出典（research/runway_reference.md §1）:
 * - 番号 = 滑走路中心線の磁方位（北から時計回り）の 1/10 に最も近い整数（FAA-AIM 2-3-3, EASA-DSN L.525(c)(1)(i)）。
 *   1 桁は 0 を前置（EASA-DSN L.525(c)(1)(iii)）。
 * - 平行滑走路の接尾辞: 2 本は L・R、3 本は L・C・R。進入方向から見て左から右の順（FAA-AIM 2-3-3, EASA-DSN L.525(c)(1)(ii)）。
 * - 磁気偏差は公式な偏角（NOAA-WMM 等）を手入力する（EASA 等の規定ではなく入力の方針）。
 * ゲームの規則（出典で確認できなかったもの。参考資料 §8 NOT FOUND）:
 * - 0.5 の丸め（x5° の境界は切り上げ）と 0 → 36（`designatorNumber`、既存の `runwayDesignators` と一致させるため）。
 * - 逆向きの番号は「(n + 17) % 36 + 1」で、必ず 18 差（定義からの算術。出典の引用ではない）。
 * - 4 本以上の平行滑走路には自動で接尾辞を付けない（出典には番号をずらす規則があるが、ゲームでは手動の designatorSuffix で対応）。
 * - 従来形（8 方位）の滑走路には接尾辞を自動で付けない（表示・データとも従来どおり。PM 判断 K / Q-A）。
 *   自動の接尾辞は自由形にだけ付き、左右の順序と本数の数え上げも自由形どうしだけで行う（従来形は含めない）。
 *   結果として同じ番号（接尾辞を含む）になった滑走路は RUNWAY_DESIGNATOR_CONFLICT（validate.ts）が警告し、手動の designatorSuffix を促す。
 *   従来形に付くのは、明示的に設定した designatorSuffix だけ。
 */
import { designatorNumber, formatDesignator, magneticFromTrue, normalizeDeg } from '../geometry/angle';
import { compareIds } from '../model/ids';
import { isFreeRunway, type AirportLayout, type Runway, type RunwaySuffix } from '../model/types';
import { runwayAxis, runwayMidpoint } from './runway';

export type DesignatorSuffix = 'L' | 'C' | 'R' | '';

export interface RunwayDesignators {
  /** 始点側・終点側の真方位（度、[0, 360)） */
  trueDeg: [number, number];
  /** 始点側・終点側の磁方位（度、[0, 360)） */
  magDeg: [number, number];
  /** 始点側・終点側の番号（1〜36。差は必ず 18） */
  numbers: [number, number];
  /** 始点側・終点側の接尾辞（'' = なし） */
  suffix: [DesignatorSuffix, DesignatorSuffix];
  /** 表示用（例: ['09L', '27R']） */
  text: [string, string];
}

const swap = (s: DesignatorSuffix): DesignatorSuffix => (s === 'L' ? 'R' : s === 'R' ? 'L' : s);

/** 逆向きの番号。必ず 18 差 */
export const reciprocalNumber = (n: number): number => ((n + 17) % 36) + 1;

const fromSuffix = (s: RunwaySuffix): DesignatorSuffix => (s === 'none' ? '' : s);

interface Basic {
  trueDeg: number;
  magDeg: number;
  n0: number;
  n1: number;
}

function basic(r: Runway, variation: number): Basic {
  const trueDeg = runwayAxis(r).trueHeadingDeg;
  const magDeg = magneticFromTrue(trueDeg, variation);
  const n0 = designatorNumber(magDeg);
  return { trueDeg, magDeg, n0, n1: reciprocalNumber(n0) };
}

/**
 * 自動の接尾辞（始点側）。同じ番号の組（逆向きを含む）の滑走路を、進入方向から見て左から右へ並べる。
 * 基準の向きは、組の中で ID が最小の滑走路の「番号が小さい側」から見た向き。
 */
function autoSuffix(r: Runway, layout: AirportLayout, variation: number): DesignatorSuffix {
  const key = (b: Basic): number => Math.min(b.n0, b.n1);
  const me = basic(r, variation);
  const group: Runway[] = [r];
  for (const o of Object.values(layout.runways)) {
    // 従来形は自動の接尾辞の数え上げ・並べ替えに含めない（従来形には自動で付けないため。同じ番号になれば検証が警告する）
    if (o.id !== r.id && isFreeRunway(o) && key(basic(o, variation)) === key(me)) group.push(o);
  }
  if (group.length < 2 || group.length > 3) return '';
  group.sort((a, b) => compareIds(a.id, b.id));
  const ref = group[0]!;
  const rb = basic(ref, variation);
  const refDir = runwayAxis(ref).dir;
  // 番号が小さい側から見た向き（始点側の番号が小さければ始点→終点、そうでなければ逆）
  const sign = rb.n0 === key(rb) ? 1 : -1;
  const d = { x: refDir.x * sign, y: refDir.y * sign };
  // World は y が下向き。進行方向 d に対する左は (d.y, -d.x)（北向き (0,-1) なら西 (-1, 0)）
  const left = { x: d.y, y: -d.x };
  const lateral = (g: Runway): number => {
    const m = runwayMidpoint(g);
    return m.x * left.x + m.y * left.y;
  };
  // 左のものほど lateral が大きい。同値は ID の順
  const ordered = [...group].sort((a, b) => lateral(b) - lateral(a) || compareIds(a.id, b.id));
  const labels: DesignatorSuffix[] = group.length === 2 ? ['L', 'R'] : ['L', 'C', 'R'];
  const idx = ordered.findIndex((g) => g.id === r.id);
  const sCanon = labels[idx]!;
  // 番号が小さい側の接尾辞が sCanon。r の始点側が大きい番号側なら入れ替わる
  return me.n0 === key(me) ? sCanon : swap(sCanon);
}

/**
 * 滑走路番号。磁方位は `layout.magneticVariationDeg`（東偏差が正。欠落 = 0）で真方位から求める。
 * 従来形で偏差 0・接尾辞の指定なしなら、`runwayDesignators(heading)` と同じ番号になる。
 */
export function designatorsOf(r: Runway, layout: AirportLayout): RunwayDesignators {
  const variation = layout.magneticVariationDeg ?? 0;
  const b = basic(r, variation);
  let s0: DesignatorSuffix;
  if (r.designatorSuffix !== undefined) s0 = fromSuffix(r.designatorSuffix);
  else if (isFreeRunway(r)) s0 = autoSuffix(r, layout, variation);
  else s0 = '';
  const s1 = swap(s0);
  const f = (n: number, s: DesignatorSuffix): string => `${formatDesignator(n)}${s}`;
  return {
    trueDeg: [b.trueDeg, normalizeDeg(b.trueDeg + 180)],
    magDeg: [b.magDeg, normalizeDeg(b.magDeg + 180)],
    numbers: [b.n0, b.n1],
    suffix: [s0, s1],
    text: [f(b.n0, s0), f(b.n1, s1)],
  };
}
