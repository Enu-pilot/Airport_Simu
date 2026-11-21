import { facilityTiles, rectTiles } from '../layout/footprint';
import { agtStationSystemId } from '../model/agt';
import { facilityLevel } from '../model/levels';
import { sortedValues } from '../model/ids';
import type { AgtSegment, AirportLayout, Facility } from '../model/types';

/**
 * AGT 駅とターミナルエリアの接続判定（機能I、design-GHIJ-detail.md §I.3）。
 * buildTerminalModel は変更せず、経路探索（interTerminal）と状態表示
 * （transitStatus）・検証がここを共有する。
 *
 * 接続の 2 方式:
 *  (a) 建物内の駅: 親ターミナルの同一階（area.level = 駅の floorIndex）のエリアと
 *      辺を共有して隣接していれば、そのエリアに接続する（隣接連絡と同じ判定）。
 *  (b) 単独駅: 歩行ポータル（5-16）で明示接続する。ポータルの成立条件は
 *      networkGraph と同じ（稼働中のポータル・階/階層の一致）。
 * どちらでも接続できない駅は未接続（AGT_STATION_ORPHAN）で、経路には使われない。
 */

/** 駅が接続するエリア ID の一覧（ソート済み）。駅でない施設・未接続なら空 */
export function agtStationConnectedAreas(layout: AirportLayout, station: Facility): string[] {
  if (station.kind !== 'agtStation') return [];
  const out = new Set<string>();
  if (station.parentFacilityId) {
    const parent = layout.facilities[station.parentFacilityId];
    if (parent && parent.kind === 'terminal') {
      const floor = station.floorIndex ?? 0;
      const sTiles = facilityTiles(station);
      for (const area of sortedValues(layout.terminalAreas)) {
        if (area.terminalId !== parent.id || area.level !== floor) continue;
        const aTiles = rectTiles(area.origin, area.w, area.h);
        let hit = false;
        outer: for (const t of sTiles) {
          for (const u of aTiles) {
            if (Math.abs(t.x - u.x) + Math.abs(t.y - u.y) === 1) { hit = true; break outer; }
          }
        }
        if (hit) out.add(area.id);
      }
    }
  } else {
    for (const portal of sortedValues(layout.portals ?? {})) {
      if (portal.facilityId !== station.id) continue;
      if ((portal.buildState ?? 'operational') !== 'operational') continue;
      const area = layout.terminalAreas[portal.areaId];
      if (!area) continue;
      if (portal.floorIndex !== area.level) continue;
      if (portal.mapLevel !== facilityLevel(station)) continue;
      out.add(area.id);
    }
  }
  return [...out].sort();
}

/** 駅の実効地図階層（建物内は親の階層 + floorIndex、単独は自身の階層） */
export function agtStationMapLevel(layout: AirportLayout, station: Facility): number {
  if (!station.parentFacilityId) return facilityLevel(station);
  const parent = layout.facilities[station.parentFacilityId];
  return (parent ? facilityLevel(parent) : 0) + (station.floorIndex ?? 0);
}

export interface AgtSegmentUsability {
  usable: boolean;
  /** 両端の駅が接続するエリア（from 側 / to 側）。usable のとき両方とも 1 件以上 */
  fromAreas: string[];
  toAreas: string[];
}

/**
 * セグメントが経路探索に使えるか: 系統・両端の駅が実在し稼働中で、駅の所属系統が
 * セグメントの系統と一致し、両端の駅がエリアに接続していること（§I.3-5 の不成立条件）。
 */
export function agtSegmentUsability(layout: AirportLayout, segment: AgtSegment): AgtSegmentUsability {
  const none: AgtSegmentUsability = { usable: false, fromAreas: [], toAreas: [] };
  const system = layout.agtSystems?.[segment.systemId];
  if (!system || (system.buildState ?? 'operational') !== 'operational') return none;
  const from = layout.facilities[segment.fromStationId];
  const to = layout.facilities[segment.toStationId];
  if (!from || !to || from.kind !== 'agtStation' || to.kind !== 'agtStation') return none;
  if ((from.buildState ?? 'operational') !== 'operational' || (to.buildState ?? 'operational') !== 'operational') return none;
  if (agtStationSystemId(from) !== segment.systemId || agtStationSystemId(to) !== segment.systemId) return none;
  const fromAreas = agtStationConnectedAreas(layout, from);
  const toAreas = agtStationConnectedAreas(layout, to);
  if (fromAreas.length === 0 || toAreas.length === 0) return none;
  return { usable: true, fromAreas, toAreas };
}
