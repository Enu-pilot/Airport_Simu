import { createSite } from '../../src/core/model/site';
import { createEmptyLayout, type OpResult } from '../../src/core/layout/operations';
import type { AirportLayout } from '../../src/core/model/types';

/** 全面草地の小さな敷地（未取得地なし）を持つ空レイアウト */
export function emptyLayout(width = 80, height = 60): AirportLayout {
  const site = createSite({ width, height, offsiteMargin: 0 });
  site.terrain = site.terrain.map(() => 0);
  return createEmptyLayout(site, 'test');
}

/** 成功を前提に OpResult を展開する */
export function must(r: OpResult): { layout: AirportLayout; created: string[] } {
  if (!r.ok) throw new Error(`operation failed: ${r.reason}`);
  return r;
}
