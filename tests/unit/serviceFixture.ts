import { placeTerminalArea, type OpResult } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import type { AirportLayout } from '../../src/core/model/types';
import { must } from './helpers';

/** サンプル空港のターミナルへ売店・食堂を追加したフィクスチャ（5-19 粒度分離テスト用） */
export function layoutWithShops(): { layout: AirportLayout; terminal: string; shop: string; restaurant: string; waiting: string } {
  let layout = createSampleAirport();
  const apply = (r: OpResult): string[] => {
    const m = must(r);
    layout = m.layout;
    return m.created;
  };
  const terminal = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
  const shop = apply(placeTerminalArea(layout, terminal, 1, 'shop', { x: 90, y: 51 }, { w: 3, h: 2, name: '売店', props: { capacity: 8 } }))[0]!;
  const restaurant = apply(placeTerminalArea(layout, terminal, 1, 'restaurant', { x: 74, y: 51 }, { w: 5, h: 2, name: '食堂', props: { capacity: 10 } }))[0]!;
  const waiting = Object.values(layout.terminalAreas).find((a) => a.terminalId === terminal && a.kind === 'waiting')!.id;
  return { layout, terminal, shop, restaurant, waiting };
}
