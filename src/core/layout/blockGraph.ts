import type { AirportLayout } from '../model/types';
import { createContext } from '../sim/context';
import type { TaxiBlockGraph } from '../sim/taxiBlocks';

/**
 * 区間の構造（taxiMode 'block' のときだけ）。配置から決まる派生データなので、レイアウトのオブジェクトごとに 1 回だけ作って使い回す
 * （2D・3D の表示・プロパティ欄で共有。保存しない）。従来方式の配置は null。
 */
const cache = new WeakMap<AirportLayout, TaxiBlockGraph | null>();

function buildOrNull(layout: AirportLayout): TaxiBlockGraph | null {
  try {
    return createContext(layout).blocks ?? null;
  } catch {
    return null;
  }
}

export function blockGraphOf(layout: AirportLayout): TaxiBlockGraph | null {
  if (layout.taxiMode !== 'block') return null;
  if (cache.has(layout)) return cache.get(layout)!;
  const g = buildOrNull(layout);
  cache.set(layout, g);
  return g;
}
