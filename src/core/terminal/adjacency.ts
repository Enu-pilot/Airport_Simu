import type { AirportLayout, Facility, TerminalArea } from '../model/types';
import { facilityLevel } from '../model/levels';
import { facilityTiles, rectTiles } from '../layout/footprint';
import { sortedValues } from '../model/ids';

/**
 * 交通施設とターミナル内エリアの「同一階層での辺接触」による連絡（隣接連絡）。
 *
 * 歩行ポータル（5-16）は明示的な接続だが、交通施設がターミナル建物のエリアと
 * 同じ地図階層で辺を共有して接している場合は、施設そのものがターミナルに
 * 連絡しているとみなす（例: ターミナル脇の地下階で、地下階のエリアに接する地下駅）。
 *
 * - 階層の一致: 施設の地図階層（facilityLevel）＝ エリアの実効階層
 *   （ターミナル施設の地図階層 ＋ エリアの建物内階 level）。
 * - 「接する」は辺を共有する隣接のみ（マンハッタン距離 1）。角だけの接触は含まない。
 * - 相手はターミナル所属エリアに限る（野外エリア等は対象外）。
 * - どのエリアに接しても「連絡」の候補にはなるが、入口・出口まで実際に届くかは
 *   複合グラフ（networkGraph）の経路探索が決める（ポータルと同じ原則）。
 */

/** 隣接連絡の対象になる交通施設の種別（ポータルの対象種別 PORTAL_FACILITY_KINDS と一致させる） */
export const ADJACENCY_FACILITY_KINDS: readonly Facility['kind'][] = ['railStation', 'busTerminal', 'busStop', 'taxiStand', 'parking'];

export interface TerminalAreaAdjacency {
  areaId: string;
  terminalId: string;
}

/** エリアの実効地図階層（ターミナルの mapLevel ＋ 建物内階） */
export function areaMapLevel(layout: AirportLayout, area: TerminalArea): number {
  const terminal = layout.facilities[area.terminalId];
  return (terminal ? facilityLevel(terminal) : 0) + area.level;
}

/**
 * 施設が同一階層で辺接触しているターミナルエリアの一覧（エリア ID 順）。
 * 対象種別でない施設・階層が違うエリア・角接触のみのエリアは含まない。
 */
export function adjacentTerminalAreas(layout: AirportLayout, facility: Facility): TerminalAreaAdjacency[] {
  if (!ADJACENCY_FACILITY_KINDS.includes(facility.kind)) return [];
  const level = facilityLevel(facility);
  const fTiles = facilityTiles(facility);
  const out: TerminalAreaAdjacency[] = [];
  for (const area of sortedValues(layout.terminalAreas)) {
    const terminal = layout.facilities[area.terminalId];
    if (!terminal || terminal.kind !== 'terminal') continue;
    if (areaMapLevel(layout, area) !== level) continue;
    const aTiles = rectTiles(area.origin, area.w, area.h);
    let hit = false;
    outer: for (const t of fTiles) {
      for (const u of aTiles) {
        if (Math.abs(t.x - u.x) + Math.abs(t.y - u.y) === 1) { hit = true; break outer; }
      }
    }
    if (hit) out.push({ areaId: area.id, terminalId: area.terminalId });
  }
  return out;
}
