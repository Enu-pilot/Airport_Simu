import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import type { AirportLayout, PaxZone, TerminalArea, TerminalAreaKind } from '../../src/core/model/types';
import { intlAirport } from './intlLayout';

/**
 * フェーズ 4 §5 のテスト用: 乗継保安検査と、出発区域への昇降を足したレイアウト。
 * 配置（レベル 0 = 到着側）:
 * - 乗継保安検査（ta_t1）: 到着通路と手荷物受取所に接する（到着 → 出発の境界）
 * - 昇降（ta_t2、区域は出発）: 乗継保安検査に接し、レベル 1 の待合（ta_t3）と重なる
 * - 待合（ta_t3）: トイレ経由で出発ロビーに接する
 * チェックイン（ta_10）は x58..89 に寄せて、昇降と待合の場所を空ける。
 */
function addTransfers(l: AirportLayout): AirportLayout {
  const terminalId = Object.values(l.facilities).find((f) => f.kind === 'terminal')!.id;
  const checkIn = Object.values(l.terminalAreas).find((a) => a.kind === 'checkIn')!;
  checkIn.origin = { x: 58, y: 53 };
  checkIn.w = 32; // x58..89
  const add = (id: string, kind: TerminalAreaKind, zone: PaxZone, level: number, x: number, y: number, w: number, h: number, props: TerminalArea['props'] = {}) => {
    l.terminalAreas[id] = { id, terminalId, level, kind, name: id, origin: { x, y }, w, h, zone, props };
  };
  add('ta_t1', 'transferSecurity', 'departure', 0, 46, 51, 12, 2, { lanes: 2 });
  add('ta_t2', 'escalator', 'departure', 0, 46, 53, 12, 2, { travelSec: 30 });
  add('ta_t3', 'waiting', 'departure', 1, 46, 53, 12, 2, { seats: 100 });
  return l;
}

/** 国内線だけの乗継レイアウト（見本空港 + 乗継設備） */
export function domTransferAirport(): AirportLayout {
  return addTransfers(createSampleAirport());
}

/** 国際線ウィング付きの乗継レイアウト（DI / ID のテスト用） */
export function transferAirport(): AirportLayout {
  return addTransfers(intlAirport());
}
