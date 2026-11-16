import { placeFacility, placeTerminalArea, updateEntity } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import type { AirportLayout, TerminalAreaKind } from '../../src/core/model/types';
import { must } from '../unit/helpers';

/**
 * 監査テスト b_ 用の共通レイアウト。
 * サンプル空港（ターミナル fac_2・ゲート fac_3..fac_11・スポット std_1..std_9）に、
 * 同じ区画構成の 2 つ目のターミナルを (106,70) に追加する。
 */
export interface TwoTerminal {
  layout: AirportLayout;
  /** 1 つ目 / 2 つ目のターミナル施設 ID */
  t1: string;
  t2: string;
}

export function addSecondTerminal(base: AirportLayout, at: { x: number; y: number } = { x: 106, y: 70 }): TwoTerminal {
  let layout = base;
  const t1 = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
  const originalAreas = Object.values(layout.terminalAreas).filter((a) => a.terminalId === t1);
  const dx = at.x - 46;
  const dy = at.y - 49;
  layout = must(placeFacility(layout, 'terminal', at, { w: 48, h: 8, name: 'ターミナルB', props: { levels: 2 } })).layout;
  const t2 = Object.values(layout.facilities).filter((f) => f.kind === 'terminal').at(-1)!.id;
  for (const area of originalAreas) {
    layout = must(
      placeTerminalArea(layout, t2, area.level, area.kind as TerminalAreaKind, { x: area.origin.x + dx, y: area.origin.y + dy }, { w: area.w, h: area.h, name: `${area.name} B`, props: structuredClone(area.props) }),
    ).layout;
  }
  return { layout, t1, t2 };
}

/**
 * 2 ターミナル + 2 つのバスゲート。
 * fac_10 = バスゲート（ターミナルA に隣接）、fac_11 = バスゲート（connectedTo = ターミナルB の独立ゲート）。
 * std_8(83,42) / std_9(88,42) はコンタクトゲートを外してリモートスポット（remoteBoarding 未設定 = 旧データ / 'auto' で試験）。
 * 他の std_1..std_7 はコンタクトのまま（fac_3..fac_9）。GSE 基地にランプバス 4 台。
 */
export function busTwoTerminalLayout(opts: { buses?: number } = {}): TwoTerminal {
  const tt = addSecondTerminal(createSampleAirport());
  let l = tt.layout;
  l = must(updateEntity(l, 'fac_10', { props: { boardingMode: 'bus', standId: null, jetBridge: false } })).layout;
  l = must(updateEntity(l, 'fac_11', { props: { boardingMode: 'bus', standId: null, jetBridge: false, connectedTo: tt.t2 } })).layout;
  l = must(updateEntity(l, 'fac_14', { props: { ...l.facilities.fac_14!.props, apronBuses: opts.buses ?? 4 } })).layout;
  return { ...tt, layout: l };
}
