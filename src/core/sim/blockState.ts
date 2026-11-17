import type { SimState } from './types';

/**
 * 区間ごとに進む地上走行の占有（SimState.taxiBlocks）の後始末。routes.ts の releaseAll から呼ぶ（解放を 1 か所に集める。plan §2.7）。
 * 依存を持たない（循環を避ける）。
 */
export function releaseTaxiBlocks(state: SimState, acId: string): void {
  const tb = state.taxiBlocks;
  if (!tb) return;
  for (const [bid, list] of Object.entries(tb.occ)) {
    if (!list.includes(acId)) continue;
    const rest = list.filter((x) => x !== acId);
    if (rest.length === 0) delete tb.occ[bid];
    else tb.occ[bid] = rest;
  }
  for (const [cid, lock] of Object.entries(tb.locks)) {
    if (!lock.holders.includes(acId)) continue;
    lock.holders = lock.holders.filter((x) => x !== acId);
    if (lock.holders.length === 0) delete tb.locks[cid];
  }
  if (tb.oppWait) {
    for (const [cid, w] of Object.entries(tb.oppWait)) if (w.acId === acId) delete tb.oppWait[cid];
    if (Object.keys(tb.oppWait).length === 0) delete tb.oppWait;
  }
  if (tb.priority === acId) {
    delete tb.priority;
    delete tb.priorityAt;
  }
}
