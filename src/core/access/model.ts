import { sortedValues } from '../model/ids';
import type { AirportLayout, Facility } from '../model/types';
import { tileKey } from '../geometry/vec';
import { facilityTiles } from '../layout/footprint';
import { BALANCE } from '../economy/balance';
import type { CityConfig } from '../economy/city';
import { cityTravelMinutes, railServiceAvailable, railServiceOf, RAIL_SERVICE } from './rail';
import { cityEventEffects } from '../economy/city';
import {
  ACCESS_MAX_WALK_TILES,
  PARKING_MAX_WALK_TILES,
  buildLandsideNetwork,
  distanceToTerminal,
  touchesTilesAtLevel,
  walkMinutes,
  type LandsideNetwork,
} from './landside';
import { facilityLevel } from '../model/levels';
import { findPedestrianRoute, type WalkRoute } from './verticalWalk';
import { analyzeSegments, type AccessSegments } from './segments';

export type { AccessSegments, SegmentPath } from './segments';

/**
 * 旅客の空港アクセス手段の選択（docs/15_access_rules.md §3）。ゲーム用の簡易なロジットモデル。
 *
 *   効用 U = 定数項 − β × (所要時間 + 待ち時間 + 混雑の遅れ + 運賃 / 時間価値)
 *   分担率 = exp(U) / Σ exp(U)（利用できる手段のみ）
 *   アクセス性 A = Σ exp(U)、アクセス係数 = min(1.1, 0.3 + 0.85 × (1 − exp(−A / 0.2)))
 *
 * アクセス係数は搭乗率（需要）に掛かる。手段を増やしても A は飽和するので、施設を置くだけで旅客が無限に増えることはない。
 * 外部とつながっていない施設・ターミナルから遠い施設は使われない。容量の超過は運航中に遅れ・満車として現れ、
 * 翌日以降の所要時間（feedback）に反映される。
 */

export type AccessMode = 'car' | 'dropoff' | 'taxi' | 'bus' | 'rail' | 'walk';
export const ACCESS_MODES: readonly AccessMode[] = ['car', 'dropoff', 'taxi', 'bus', 'rail', 'walk'];
export type TransitMode = 'taxi' | 'bus' | 'rail';

/** 手段が使えない理由 */
export type AccessUnavailable =
  | 'noTerminal' // 運用中のターミナルがない
  | 'noEntrance' // 敷地の外へつながる一般道路がない
  | 'noFacility' // 施設がない
  | 'notConnected' // 施設が外部につながる道路・鉄道に接していない
  | 'tooFar' // ターミナルから遠すぎる
  | 'noCurb' // ターミナルが一般道路に接していない（車寄せなし）
  | 'noService' // 都市側の鉄道整備度で列車種別が運行できない
  | 'noCapacity'; // 容量 0（台数・本数が 0）

/** 前日の運航で観測した混雑（翌日の所要時間に反映する） */
export interface AccessFeedback {
  roadDelayMin: number;
  curbDelayMin: number;
  /** 自家用車で来て満車だった割合 */
  parkingFullRate: number;
  /** 到着旅客の乗り場での平均待ち（分） */
  waitMin: Partial<Record<TransitMode, number>>;
}

export interface AccessFees {
  carPark: number;
  taxi: number;
  bus: number;
  rail: number;
}

export interface ModeInfo {
  mode: AccessMode;
  available: boolean;
  reason: AccessUnavailable | null;
  /** 使える施設（ID 順） */
  facilities: string[];
  /** 施設からターミナルまでの徒歩（分）、乗り場の平均待ち（分）、混雑の遅れ（分） */
  walkMin: number;
  waitMin: number;
  delayMin: number;
  /** 合計の所要時間（分）と、旅客1人あたりの運賃（cr） */
  timeMin: number;
  fare: number;
  utility: number;
  share: number;
  /** 処理能力（人/時、制限なしは null） */
  capacityPerHour: number | null;
}

export interface AccessAnalysis {
  terminalId: string | null;
  network: LandsideNetwork;
  /** 一般車の出入口の数 */
  entrances: number;
  modes: Record<AccessMode, ModeInfo>;
  accessibility: number;
  factor: number;
  /** 道路（台/時）・車寄せ（台/時） */
  roadCapacityPerHour: number;
  curbCapacityPerHour: number;
  parkingSpaces: number;
  /** バス便数・列車本数（毎時）、タクシー乗車枠 */
  busesPerHour: number;
  trainsPerHour: number;
  taxiBerths: number;
  hotelRooms: number;
  /** 運用中の旅客通路に明示能力が設定されている場合の経路能力。未設定区間があれば null。 */
  railWalkCapacityPerHour: number | null;
  /** 職員数と必要・使える職員用駐車台数 */
  staff: number;
  staffSpacesNeeded: number;
  staffSpaces: number;
  /** 区間能力モデル（layout.accessCapacityModel === 'segment'）のときだけ付く解析（フェーズ 4 §6.2） */
  segments?: AccessSegments;
}

export const DEFAULT_ACCESS_FEES: AccessFees = { carPark: 1, taxi: 1, bus: 1, rail: 1 };
export const NO_FEEDBACK: AccessFeedback = { roadDelayMin: 0, curbDelayMin: 0, parkingFullRate: 0, waitMin: {} };

const M = BALANCE.accessModel;
const num = (v: unknown) => Math.max(0, Number(v ?? 0) || 0);

/** 職員数 = 作業員 + 整備士 + 窓口要員（カウンター1・保安レーン2・ゲート1人） */
export function staffCount(layout: AirportLayout): number {
  let n = 0;
  for (const f of Object.values(layout.facilities)) {
    if (f.buildState !== 'operational') continue;
    if (f.kind === 'gseBase') n += num(f.props.staff);
    if (f.kind === 'maintenance') n += num(f.props.engineers);
    if (f.kind === 'gate') n += 1;
  }
  for (const a of Object.values(layout.terminalAreas)) {
    if (a.kind === 'checkIn') n += num(a.props.counters);
    if (a.kind === 'security') n += 2 * num(a.props.lanes);
  }
  return n;
}

export function accessFactor(accessibility: number): number {
  const F = M.factor;
  return Math.min(F.max, F.floor + F.span * (1 - Math.exp(-accessibility / F.a0)));
}

export function analyzeAccess(
  layout: AirportLayout,
  opts: { fees?: Partial<AccessFees>; feedback?: AccessFeedback; city?: CityConfig; day?: number } = {},
): AccessAnalysis {
  const fees = { ...DEFAULT_ACCESS_FEES, ...opts.fees };
  const fb = opts.feedback ?? NO_FEEDBACK;
  const city = opts.city;
  const eventTraffic = cityEventEffects(city, opts.day ?? -1).trafficMultiplier;
  const net = buildLandsideNetwork(layout);
  const facilities = sortedValues(layout.facilities).filter((f) => f.buildState === 'operational' && !f.parentFacilityId);
  const terminals = facilities.filter((f) => f.kind === 'terminal');
  const terminalId = terminals[0]?.id ?? null;
  const entrances = net.entryRoads.length;

  // 車寄せ: ターミナルに接する、外部につながった一般道路のタイル
  const curbTiles = new Set<string>();
  for (const t of terminals) {
    for (const p of facilityTiles(t)) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const k = tileKey(p.x + dx, p.y + dy);
        if ((net.publicTilesByLevel[facilityLevel(t)] ?? new Set<string>()).has(k)) curbTiles.add(k);
      }
    }
  }

  interface Usable {
    facilities: Facility[];
    reason: AccessUnavailable | null;
    walkTiles: number;
    walkMin?: number;
  }
  const usable = (kind: Facility['kind'] | readonly Facility['kind'][], conn: Record<number, Set<string>>, maxWalk: number): Usable => {
    const kinds = Array.isArray(kind) ? kind : [kind];
    const all = facilities.filter((f) => kinds.includes(f.kind));
    if (all.length === 0) return { facilities: [], reason: 'noFacility', walkTiles: 0 };
    const connected = all.filter((f) => touchesTilesAtLevel(f, conn, facilityLevel(f)));
    if (connected.length === 0) return { facilities: [], reason: 'notConnected', walkTiles: 0 };
    const near = connected.map((f) => ({ f, d: distanceToTerminal(layout, f) })).filter((x) => x.d <= maxWalk);
    if (near.length === 0) return { facilities: [], reason: 'tooFar', walkTiles: 0 };
    return { facilities: near.map((x) => x.f), reason: null, walkTiles: Math.min(...near.map((x) => x.d)) };
  };

  const parking = usable('parking', net.publicTilesByLevel, PARKING_MAX_WALK_TILES);
  const taxi = usable('taxiStand', net.publicTilesByLevel, ACCESS_MAX_WALK_TILES);
  const bus = usable(['busStop', 'busTerminal'], net.publicTilesByLevel, ACCESS_MAX_WALK_TILES);
  const railNetwork = usable('railStation', net.railTilesByLevel, Number.MAX_SAFE_INTEGER);
  const terminalsForAccess = terminals.filter((f) => f.buildState === 'operational');
  const railRoutes = new Map<string, WalkRoute>();
  const legacyRailStations = new Set<string>();
  const railReachable = railNetwork.facilities.filter((station) => {
    const route = terminalsForAccess.map((terminal) => findPedestrianRoute(layout, station, terminal)).filter((r): r is WalkRoute => r !== null).sort((a, b) => a.minutes - b.minutes)[0];
    if (route && route.minutes <= walkMinutes(ACCESS_MAX_WALK_TILES)) {
      railRoutes.set(station.id, route);
      return true;
    }
    // Keep the legacy ground-level station rule when no explicit walkway route is attached.
    if (facilityLevel(station) === 0 && distanceToTerminal(layout, station) <= ACCESS_MAX_WALK_TILES) {
      legacyRailStations.add(station.id);
      return true;
    }
    return false;
  });
  const railFacilities = railReachable.filter((f) => railServiceAvailable(city, railServiceOf(f.props.railService)));
  const railWalkMin = Math.min(...railFacilities.map((f) => railRoutes.get(f.id)?.minutes ?? (legacyRailStations.has(f.id) ? walkMinutes(Math.min(distanceToTerminal(layout, f), ACCESS_MAX_WALK_TILES)) : Infinity)));
  const railRouteEdges = [...new Set(railFacilities.flatMap((f) => railRoutes.get(f.id)?.edges ?? []))];
  const railWalkCapacityPerHour = railFacilities.length && railRouteEdges.length
    ? railRouteEdges.reduce<number | null>((min, edgeId) => {
        const cap = layout.roads[edgeId]?.capacityPerHour;
        return min === null || cap === undefined ? null : Math.min(min, cap);
      }, Infinity)
    : null;
  const rail: Usable = {
    ...railNetwork,
    facilities: railFacilities,
    walkMin: Number.isFinite(railWalkMin) ? railWalkMin : 0,
    walkTiles: Number.isFinite(railWalkMin) ? railWalkMin / walkMinutes(1) : 0,
    reason: railFacilities.length > 0 ? null : railReachable.length > 0 && city ? 'noService' : railNetwork.facilities.length > 0 ? 'notConnected' : railNetwork.reason,
  };
  const hotel = usable('hotel', net.publicTilesByLevel, ACCESS_MAX_WALK_TILES);
  const parkingSpaces = parking.facilities.reduce((s, f) => s + num(f.props.spaces), 0);
  const taxiBerths = taxi.facilities.reduce((s, f) => s + num(f.props.berths), 0);
  const busesPerHour = bus.facilities.reduce((s, f) => s + Math.min(num(f.props.busesPerHour), num(f.kind === 'busTerminal' ? f.props.berths : f.props.busBays) * M.busesPerBay), 0);
  const declaredTrainsPerHour = rail.facilities.reduce((s, f) => s + num(f.props.trainsPerHour), 0);
  // フェーズ 4 §6.2: 区間能力モデルのときだけ区間解析を行い、鉄道の実効本数を使う（集約の値は比較用に残す）
  const segments = layout.accessCapacityModel === 'segment'
    ? analyzeSegments(layout, net, { railStationIds: rail.facilities.map((f) => f.id), railDeclaredTrainsPerHour: declaredTrainsPerHour })
    : undefined;
  const trainsPerHour = segments ? segments.railTrainsPerHour : declaredTrainsPerHour;
  const needsWalkCapacity = railFacilities.some((f) => !legacyRailStations.has(f.id));
  const railPaxCapacity = needsWalkCapacity ? (railWalkCapacityPerHour === null ? null : Math.min(trainsPerHour * M.trainSeats, railWalkCapacityPerHour)) : trainsPerHour * M.trainSeats;
  const weightedRail = rail.facilities.reduce((acc, f) => {
    const trains = num(f.props.trainsPerHour);
    const service = railServiceOf(f.props.railService);
    return {
      trains: acc.trains + trains,
      speed: acc.speed + trains * RAIL_SERVICE[service].speedKph,
      surcharge: acc.surcharge + trains * RAIL_SERVICE[service].fareSurcharge,
    };
  }, { trains: 0, speed: 0, surcharge: 0 });
  const railSpeed = weightedRail.trains > 0 ? weightedRail.speed / weightedRail.trains : RAIL_SERVICE.local.speedKph;
  const railFareSurcharge = weightedRail.trains > 0 ? weightedRail.surcharge / weightedRail.trains : 0;
  const hotelRooms = hotel.facilities.reduce((s, f) => s + num(f.props.rooms), 0);

  const A = BALANCE.accessFees;
  const parkFee = BALANCE.carPark.feePerCar * fees.carPark;
  const base: Record<AccessMode, { reason: AccessUnavailable | null; u: Usable | null; wait: number; delay: number; fare: number; cap: number | null }> = {
    car: { reason: parking.reason ?? (parkingSpaces > 0 ? null : 'noCapacity'), u: parking, wait: 0, delay: fb.roadDelayMin + fb.parkingFullRate * M.parkingSearchMin, fare: parkFee / M.paxPerCar, cap: null },
    dropoff: { reason: curbTiles.size > 0 ? null : 'noCurb', u: null, wait: 0, delay: fb.roadDelayMin + fb.curbDelayMin, fare: 0, cap: null },
    taxi: {
      reason: taxi.reason ?? (taxiBerths > 0 ? null : 'noCapacity'),
      u: taxi,
      wait: fb.waitMin.taxi ?? 0,
      delay: fb.roadDelayMin,
      fare: M.baseFare.taxi / M.paxPerCar + A.taxi * fees.taxi,
      cap: taxiBerths * M.taxiPaxPerBerth,
    },
    bus: {
      reason: bus.reason ?? (busesPerHour > 0 ? null : 'noCapacity'),
      u: bus,
      wait: busesPerHour > 0 ? 30 / busesPerHour + (fb.waitMin.bus ?? 0) : 0,
      delay: fb.roadDelayMin,
      fare: M.baseFare.bus + A.bus * fees.bus,
      cap: busesPerHour * M.busSeats,
    },
    rail: {
      reason: rail.reason ?? (trainsPerHour > 0 ? null : 'noCapacity'),
      u: rail,
      wait: trainsPerHour > 0 ? 30 / trainsPerHour + (fb.waitMin.rail ?? 0) : 0,
      delay: 0,
      fare: M.baseFare.rail + A.rail * fees.rail + railFareSurcharge,
      cap: railPaxCapacity,
    },
    walk: { reason: null, u: hotel.reason ? null : hotel, wait: 0, delay: 0, fare: 0, cap: null },
  };

  const modes = {} as Record<AccessMode, ModeInfo>;
  let total = 0;
  for (const m of ACCESS_MODES) {
    const b = base[m];
    let reason = b.reason;
    if (!terminalId) reason = 'noTerminal';
    else if (m !== 'rail' && m !== 'walk' && entrances === 0) reason = 'noEntrance';
    const walkMin = b.u ? (b.u.walkMin ?? walkMinutes(b.u.walkTiles)) : 0;
    // 徒歩: 空港ホテルがあれば宿泊客が歩いて来る（客室数に応じた定数項）
    const hotelWalk = m === 'walk' && hotelRooms > 0;
    const external = hotelWalk ? 5 : city && (m === 'car' || m === 'dropoff' || m === 'taxi' || m === 'bus')
      ? cityTravelMinutes(city, (20 + city.roadQuality * 8) * (m === 'bus' ? 0.75 : 1)) * eventTraffic
      : city && m === 'rail'
        ? cityTravelMinutes(city, railSpeed)
        : M.externalMin[m];
    const asc = hotelWalk ? Math.log(Math.min(1, hotelRooms / M.hotelRoomsForFull)) - 2 : M.asc[m];
    const timeMin = external + walkMin + b.wait + b.delay;
    const utility = asc - M.beta * (timeMin + b.fare / M.valueOfTime);
    const available = reason === null;
    if (available) total += Math.exp(utility);
    modes[m] = {
      mode: m,
      available,
      reason,
      facilities: b.u?.facilities.map((f) => f.id) ?? [],
      walkMin: round1(walkMin),
      waitMin: round1(b.wait),
      delayMin: round1(b.delay),
      timeMin: round1(timeMin),
      fare: Math.round(b.fare),
      utility,
      share: 0,
      capacityPerHour: b.cap,
    };
  }
  for (const m of ACCESS_MODES) if (modes[m].available) modes[m].share = Math.exp(modes[m].utility) / total;

  const staff = staffCount(layout);
  const staffSpaces = facilities
    .filter((f) => f.kind === 'staffParking' && touchesTilesAtLevel(f, net.anyRoadTilesByLevel, facilityLevel(f)))
    .reduce((s, f) => s + num(f.props.spaces), 0);
  return {
    terminalId,
    network: net,
    entrances,
    modes,
    accessibility: total,
    factor: terminalId ? accessFactor(total) : M.factor.floor,
    roadCapacityPerHour: entrances * M.roadPerEntrance,
    curbCapacityPerHour: curbTiles.size * M.curbPerTile,
    parkingSpaces,
    busesPerHour,
    trainsPerHour,
    taxiBerths,
    hotelRooms,
    railWalkCapacityPerHour,
    staff,
    staffSpacesNeeded: Math.ceil(staff * M.staffParkingPerStaff),
    staffSpaces,
    ...(segments ? { segments } : {}),
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
