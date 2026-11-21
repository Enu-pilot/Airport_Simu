import type { AirlineTerminalPolicy } from '../economy/company';
import type { PlannedFlight } from '../economy/planning';
import { SIZE_ORDER, type SizeClass } from '../model/types';
import { AIRCRAFT_TYPES, resolveType, type TypeTable } from '../sim/aircraftTypes';
import type { TerminalCapacitySummary } from './terminalCapacitySummary';

/**
 * 使用ターミナル指定に対するスポット容量の警告判定（表示専用・読み取りのみ）。
 *
 * 航空会社の使用ターミナルを選ぶときに「指定したターミナルのスポットが足りなく
 * なるかも」を事前に知らせるための目安で、スポット割当ロジックには一切影響しない。
 *
 * 需要の見積もり（根拠）:
 * - 便と時刻は運航計画 planDay（planning.ts）が契約から決定的に生成する計画便を
 *   そのまま使う。プレビュー（運航計画パネル）と同じ便・同じ時刻なので、
 *   実際の割当対象と食い違わない。
 * - 会社×路線種別×サイズ区分ごとに、到着〜出発の区間が重なる最大数
 *   （ピーク同時駐機数）を需要とする。前日の夜間滞泊（prevOvernight）は
 *   当日の朝まで占有する分として数える。専用スポット付きの便は許可ターミナル
 *   以外でも駐機できる（制限より優先される）ため需要から除く。貨物便は
 *   使用ターミナル制限の対象外なので planDay の旅客便には含まれない。
 * - 容量はターミナルを共有する全会社の合計で見る。複数ターミナルを指定した
 *   会社の需要は、指定ターミナルへ均等に按分する（どのターミナルへ寄るかは
 *   割当順に依存するため、按分は「目安」としての割り切り）。
 * - サイズは「そのサイズ以上」で累積して比べる（L 機は L スポットのみ、
 *   M 機は M・L スポットを使える、という実際の割当条件と同じ）。
 *
 * 警告は2段:
 * - 確定警告（missingSizes）: その会社が運航するサイズ区分について、許可
 *   ターミナル群にそのサイズ以上のスポットが 0 件。便が物理的に入れない。
 * - 逼迫警告（pressures）: ターミナルごとの合計需要が容量を超える（over）、
 *   または容量の SPOT_PRESSURE_RATIO 以上に迫る（tight）。
 */

export type SpotRouteType = 'domestic' | 'international';

/** 逼迫とみなす需要/容量の割合（目安） */
export const SPOT_PRESSURE_RATIO = 0.9;

const DAY_SEC = 86400;
const SIZES_DESC: SizeClass[] = ['L', 'M', 'S'];

export interface TerminalSpotPressure {
  terminalId: string;
  /** 逼迫しているサイズ帯（このサイズ以上のスポットで判定） */
  sizeAtLeast: SizeClass;
  /** 按分後のピーク需要（機数。小数がありうる） */
  demand: number;
  /** そのサイズ以上のスポット数 */
  capacity: number;
  /** over = 需要が容量超過、tight = 容量に迫っている */
  level: 'over' | 'tight';
}

export interface AirlineTerminalSpotWarning {
  airlineId: string;
  routeType: SpotRouteType;
  /** 確定警告: 許可ターミナル群にそのサイズ以上のスポットが無いサイズ区分 */
  missingSizes: SizeClass[];
  /** 逼迫警告: 指定ターミナルのうち容量が逼迫しているもの */
  pressures: TerminalSpotPressure[];
}

interface Occupancy {
  airlineId: string;
  routeType: SpotRouteType;
  size: SizeClass;
  from: number;
  to: number;
}

const routeTypeOf = (f: PlannedFlight): SpotRouteType => (f.routeType === 'international' ? 'international' : 'domestic');

function occupancies(flights: readonly PlannedFlight[], prevOvernight: readonly PlannedFlight[], types: TypeTable): Occupancy[] {
  const out: Occupancy[] = [];
  const push = (f: PlannedFlight, from: number, to: number) => {
    // 専用スポットの便は制限の外で駐機できるため、許可ターミナルの需要に入れない
    if (f.dedicatedStandId) return;
    if (to <= from) return;
    out.push({ airlineId: f.airlineId, routeType: routeTypeOf(f), size: resolveType(types, f.typeId).size, from, to });
  };
  for (const f of flights) push(f, f.arrivalAt, Math.min(f.departureAt, DAY_SEC));
  // 前日の滞泊は当日の 0 時から出発時刻まで占有する
  for (const f of prevOvernight) push(f, 0, f.departureAt - DAY_SEC);
  return out;
}

/** (会社, 路線種別, サイズ) ごとのピーク同時駐機数 */
function peakByAirlineSize(occ: readonly Occupancy[]): Map<string, number> {
  const groups = new Map<string, { time: number; delta: number }[]>();
  for (const o of occ) {
    const key = `${o.airlineId}|${o.routeType}|${o.size}`;
    const events = groups.get(key) ?? [];
    events.push({ time: o.from, delta: 1 }, { time: o.to, delta: -1 });
    groups.set(key, events);
  }
  const peaks = new Map<string, number>();
  for (const [key, events] of groups) {
    // 同時刻では出発（-1）を先に処理する（スポットは出発後に空く）
    events.sort((a, b) => a.time - b.time || a.delta - b.delta);
    let current = 0;
    let peak = 0;
    for (const e of events) {
      current += e.delta;
      if (current > peak) peak = current;
    }
    peaks.set(key, peak);
  }
  return peaks;
}

const atLeast = (bySize: Record<SizeClass, number>, size: SizeClass): number =>
  SIZES_DESC.filter((s) => SIZE_ORDER[s] >= SIZE_ORDER[size]).reduce((sum, s) => sum + (bySize[s] ?? 0), 0);

/**
 * 使用ターミナル指定に対するスポット容量の警告を、会社×路線種別ごとに返す。
 * 制限のない会社・路線種別には警告を出さない。警告が無い組は結果に含めない。
 */
export function airlineTerminalSpotWarnings(input: {
  /** terminalCapacitySummaries の結果 */
  summaries: ReadonlyMap<string, TerminalCapacitySummary>;
  /** CompanyState['airlineTerminals'] */
  policies: Record<string, AirlineTerminalPolicy> | undefined;
  /** planDay が生成した当日の計画便 */
  flights: readonly PlannedFlight[];
  /** planDay の前日滞泊分（当日の朝まで占有） */
  prevOvernight?: readonly PlannedFlight[];
  types?: TypeTable;
}): AirlineTerminalSpotWarning[] {
  const { summaries, policies } = input;
  if (!policies) return [];
  const types = input.types ?? AIRCRAFT_TYPES;
  const peaks = peakByAirlineSize(occupancies(input.flights, input.prevOvernight ?? [], types));

  // ターミナルごとの合計需要（サイズ別）: 指定した全会社のピークを按分して集める
  const demandByTerminal = new Map<string, Record<SizeClass, number>>();
  const addDemand = (terminalId: string, size: SizeClass, amount: number) => {
    let bySize = demandByTerminal.get(terminalId);
    if (!bySize) {
      bySize = { S: 0, M: 0, L: 0 };
      demandByTerminal.set(terminalId, bySize);
    }
    bySize[size] += amount;
  };

  interface Cell {
    airlineId: string;
    routeType: SpotRouteType;
    designated: string[];
    operatedSizes: SizeClass[];
  }
  const cells: Cell[] = [];
  for (const [airlineId, policy] of Object.entries(policies)) {
    for (const routeType of ['domestic', 'international'] as const) {
      const designated = policy[routeType];
      if (!designated || designated.length === 0) continue;
      const operatedSizes = SIZES_DESC.filter((s) => (peaks.get(`${airlineId}|${routeType}|${s}`) ?? 0) > 0);
      cells.push({ airlineId, routeType, designated: [...designated], operatedSizes });
      for (const size of operatedSizes) {
        const share = peaks.get(`${airlineId}|${routeType}|${size}`)! / designated.length;
        for (const terminalId of designated) addDemand(terminalId, size, share);
      }
    }
  }

  // ターミナルごとの逼迫判定（サイズ累積で最も厳しい帯を見る）
  const pressureByTerminal = new Map<string, TerminalSpotPressure>();
  for (const [terminalId, demand] of demandByTerminal) {
    const summary = summaries.get(terminalId);
    if (!summary) continue;
    let worst: TerminalSpotPressure | null = null;
    let worstRatio = -1;
    for (const size of SIZES_DESC) {
      const demandCum = atLeast(demand, size);
      if (demandCum <= 0) continue;
      const capacityCum = atLeast(summary.standsBySize, size);
      const ratio = capacityCum > 0 ? demandCum / capacityCum : Infinity;
      if (ratio > worstRatio) {
        worstRatio = ratio;
        worst = {
          terminalId,
          sizeAtLeast: size,
          demand: demandCum,
          capacity: capacityCum,
          level: demandCum > capacityCum ? 'over' : 'tight',
        };
      }
    }
    if (worst && (worst.level === 'over' || worstRatio >= SPOT_PRESSURE_RATIO)) {
      pressureByTerminal.set(terminalId, worst);
    }
  }

  const warnings: AirlineTerminalSpotWarning[] = [];
  for (const cell of cells) {
    const missingSizes = cell.operatedSizes.filter((size) => {
      const total = cell.designated.reduce(
        (sum, terminalId) => sum + atLeast(summaries.get(terminalId)?.standsBySize ?? { S: 0, M: 0, L: 0 }, size),
        0,
      );
      return total <= 0;
    });
    const pressures = cell.designated
      .map((terminalId) => pressureByTerminal.get(terminalId))
      .filter((p): p is TerminalSpotPressure => p !== undefined)
      // そのサイズのスポットが 0 件という確定警告と同義の逼迫（容量 0）は重ねて出さない
      .filter((p) => !(p.capacity <= 0 && missingSizes.includes(p.sizeAtLeast)));
    if (missingSizes.length === 0 && pressures.length === 0) continue;
    warnings.push({ airlineId: cell.airlineId, routeType: cell.routeType, missingSizes, pressures });
  }
  return warnings;
}
