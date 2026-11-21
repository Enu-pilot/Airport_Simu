import { AGT_PARAM_RANGES } from './catalog';
import type { AgtSegment, AgtSystem, AirportLayout, Facility } from './types';

/**
 * AGT（新交通システム、機能I）の読み取りの正。design-GHIJ-detail.md §I が正本。
 * 欠落 = 従来どおり（AGT の無いレイアウトでは全て空・0 を返す）。
 * 運行は集約モデル: 車両の位置は持たず、辺の所要時間・容量は系統パラメータから決まる。
 */

/** 駅施設の系統 ID（props.systemId）。未指定・不正な型は null */
export function agtStationSystemId(facility: Facility): string | null {
  const v = facility.props.systemId;
  return typeof v === 'string' && v !== '' ? v : null;
}

/** 駅が属する系統。駅でない・未指定・系統が無い場合は undefined */
export function agtSystemOfStation(layout: AirportLayout, station: Facility): AgtSystem | undefined {
  const id = agtStationSystemId(station);
  return id ? layout.agtSystems?.[id] : undefined;
}

/** 系統パラメータの範囲外のキー（範囲内なら null）。操作と検証の両方が使う。speedMps のみ小数可 */
export function agtParamProblem(system: Pick<AgtSystem, 'vehicleCapacity' | 'headwaySec' | 'dwellSec' | 'speedMps'>): keyof typeof AGT_PARAM_RANGES | null {
  for (const key of Object.keys(AGT_PARAM_RANGES) as (keyof typeof AGT_PARAM_RANGES)[]) {
    const v = system[key];
    const r = AGT_PARAM_RANGES[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < r.min || v > r.max) return key;
    if (key !== 'speedMps' && !Number.isInteger(v)) return key;
  }
  return null;
}

/** セグメント 1 本の所要時間（秒）= 平均待ち headwaySec/2 + 走行 distanceM/speedMps + 停車 dwellSec */
export function agtSegmentTravelSec(system: AgtSystem, segment: AgtSegment): number {
  return system.headwaySec / 2 + segment.distanceM / system.speedMps + system.dwellSec;
}

/** セグメントの方向別容量（人/時）= 編成定員 × 3600 / 運転間隔 */
export function agtSegmentCapacityPerHour(system: AgtSystem): number {
  return Math.floor((system.vehicleCapacity * 3600) / system.headwaySec);
}

/** 系統のセグメント総延長（m、片方向の合計） */
export function agtSystemTotalDistanceM(layout: AirportLayout, systemId: string): number {
  let total = 0;
  for (const seg of Object.values(layout.agtSegments ?? {})) if (seg.systemId === systemId) total += seg.distanceM;
  return total;
}

/** 系統に所属する駅の数（駅施設の props.systemId で数える） */
export function agtSystemStationCount(layout: AirportLayout, systemId: string): number {
  let n = 0;
  for (const f of Object.values(layout.facilities)) if (f.kind === 'agtStation' && agtStationSystemId(f) === systemId) n++;
  return n;
}

/**
 * 必要編成数 = ceil(総延長 × 2 / (速度 × 間隔))。
 * 総延長 0（セグメントなし）の系統は 0 編成（運行費も 0）。
 */
export function agtSystemTrainsets(layout: AirportLayout, system: AgtSystem): number {
  const total = agtSystemTotalDistanceM(layout, system.id);
  if (total <= 0) return 0;
  return Math.ceil((total * 2) / (system.speedMps * system.headwaySec));
}

/** 駅に接続するセグメント（両端のどちらでも） */
export function agtSegmentsAtStation(layout: AirportLayout, stationId: string): AgtSegment[] {
  return Object.values(layout.agtSegments ?? {})
    .filter((s) => s.fromStationId === stationId || s.toStationId === stationId)
    .sort((a, b) => a.id.localeCompare(b.id));
}
