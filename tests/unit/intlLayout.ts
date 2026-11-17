import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import type { AirportLayout, TerminalArea, TerminalAreaKind } from '../../src/core/model/types';
import type { PaxZone } from '../../src/core/model/types';

/**
 * フェーズ 4 §4 のテスト用: 見本空港のターミナルに国際線ウィングを足したレイアウト。
 * 配置（レベル 1 = 出発側、レベル 0 = 到着側）:
 * - 出発: 保安検査 → 出発ロビー → 出国審査（ta_i3）→ 国際ホール（ta_i2）→ 国際待合（ta_i1）→ ゲート fac_10
 * - 到着: ゲート fac_10 → 国際到着ホール（ta_i4）→ 国際ホール（ta_i5）→ 入国審査（ta_i6）→ 手荷物受取 → 税関（ta_i8）→ 入口（一般区域）
 * ゲート fac_10（スポット std_8）を国際ゲートにする。
 */
export function intlAirport(): AirportLayout {
  const l = createSampleAirport();
  const terminalId = Object.values(l.facilities).find((f) => f.kind === 'terminal')!.id;
  const area = (kind: TerminalAreaKind) => Object.values(l.terminalAreas).find((a) => a.kind === kind)!;
  // 国内側のエリアを少し縮めて国際ウィングの場所を空ける
  area('departureLobby').w = 34; // x46..79
  area('arrivalCorridor').w = 34; // x46..79
  const waiting = area('waiting');
  waiting.origin = { x: 88, y: 51 };
  waiting.w = 6;
  const claim = area('baggageClaim');
  claim.w = 22; // x58..79（入国審査に接する）
  // 出口（ta_3）は x58..77 のまま: 税関（x78..）と接する
  // 入口（ta_4）は動かさない: エスカレーター（ta_5）との隣接が国内線の上下移動に要る

  const add = (id: string, kind: TerminalAreaKind, zone: PaxZone, level: number, x: number, y: number, w: number, h: number, props: TerminalArea['props'] = {}) => {
    l.terminalAreas[id] = { id, terminalId, level, kind, name: id, origin: { x, y }, w, h, zone, props };
  };
  add('ta_i1', 'waiting', 'departureIntl', 1, 80, 49, 8, 2, { seats: 100 });
  add('ta_i2', 'hall', 'departureIntl', 1, 80, 51, 8, 2);
  add('ta_i3', 'emigration', 'departureIntl', 1, 74, 51, 6, 2, { lanes: 4 });
  add('ta_i4', 'waiting', 'arrivalIntl', 0, 80, 49, 8, 2);
  add('ta_i5', 'hall', 'arrivalIntl', 0, 80, 51, 6, 2);
  add('ta_i6', 'immigration', 'arrival', 0, 80, 53, 6, 1, { booths: 6 });
  add('ta_i8', 'customs', 'landside', 0, 78, 54, 2, 3, { lanes: 4 });

  const gate = Object.values(l.facilities).find((f) => f.kind === 'gate' && f.props.standId === 'std_8')!;
  gate.props.routeType = 'international';
  return l;
}

/** 国際ゲート（fac_10、スポット std_8）の ID */
export function intlGateId(l: AirportLayout): string {
  return Object.values(l.facilities).find((f) => f.kind === 'gate' && f.props.standId === 'std_8')!.id;
}
