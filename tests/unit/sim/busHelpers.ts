import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AirportLayout } from '../../../src/core/model/types';

/** バス搭乗のテスト用レイアウト: サンプル空港のゲート 1 つをバスゲートにし、もう 1 つを外してリモートスポットを 2 つ作る */
export function busLayout(opts: { buses?: number; gate?: 'bus' | 'none' } = {}): AirportLayout {
  const l = JSON.parse(readFileSync(resolve(__dirname, '../../golden/fixtures/sample.layout.json'), 'utf8')) as AirportLayout;
  delete l.facilities['fac_10'];
  if (opts.gate !== 'none') {
    const g = l.facilities['fac_6']!;
    g.props = { standId: null, jetBridge: false, boardingMode: 'bus' };
  } else {
    delete l.facilities['fac_6'];
  }
  const base = Object.values(l.facilities).find((f) => f.kind === 'gseBase')!;
  if ((opts.buses ?? 3) > 0) base.props.apronBuses = opts.buses ?? 3;
  return l;
}
