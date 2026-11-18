import type { AirportLayout } from '../model/types';
import { compareIds } from '../model/ids';
import { serviceSecPerPax } from '../terminal/capacity';
import { analyzeAccess, ACCESS_MODES } from '../access/model';
import { BALANCE } from './balance';
import { terminalLinkCapacityPerHour } from '../terminal/model';
import { APRON_BUS_CAPACITY } from '../sim/busRules';
import type { SimContext } from '../sim/context';
import { operableTypes } from '../sim/context';
import { taxiwayCapacityPerHour } from '../sim/taxiBlocks';
import { BLOCK_REQ_M } from '../sim/rules';
import { resolveType } from '../sim/aircraftTypes';
import { cityOperatingHours } from './city';
import { airportFireCategory, requiredFireCategory, towerCapacityPerHour, towerLevel } from '../safety';
import { runwaySystemCapacity } from '../runwayCapacity';
import type { CompanyState, Contract, TimeWindow } from './company';
import { addContract } from './company';
import { internationalProcessingFor, routeCapabilitiesForAirport } from './registry';
import { analyzeHub, TRANSFER_KINDS } from '../terminal/hub';
import { planConnections } from './hub';
import {
  analyzeDayPlan,
  CHECKIN_SHARE,
  planDayWithDemand,
  RUNWAY_HOURLY_CAPACITY,
  STAND_GAP_SEC,
  turnaroundCapacity,
  type DayPlan,
  type PlanAnalysis,
} from './planning';

export type CapacityStatus = 'adequate' | 'warning' | 'shortage' | 'uncomputed';
export interface CapacityMetric {
  name: string;
  unit: 'movements/h' | 'movements/day' | 'aircraft' | 'pax' | 'pax/h' | 'pax/day' | 'aircraft/day' | 'units' | 'pax/trip' | 'vehicles/h' | 'trains/h' | 'fuel/h';
  capacity: number | null;
  demand: number | null;
  utilization: number | null;
  spare: number | null;
  status: CapacityStatus;
  basis: string;
}
export interface CapacityFacilityRow {
  id: string;
  name: string;
  kind: string;
  state: 'operational' | 'planned' | 'construction';
  terminalId?: string;
  capacity: number | null;
  demand: number | null;
  unit: CapacityMetric['unit'];
  status: CapacityStatus;
  basis: string;
}
export interface AirportCapacitySnapshot {
  plan: DayPlan;
  analysis: PlanAnalysis;
  operatingHours: number;
  summary: CapacityMetric[];
  /** 空港全体の離発着能力（滑走路・スポット回転・折り返しの最小。誘導路は未算出のため含めない）と、制約になっている要素（AS-6） */
  overall: { capacity: number | null; limitedBy: 'runway' | 'stand' | 'turnaround' | null };
  bottlenecks: CapacityMetric[];
  facilities: CapacityFacilityRow[];
  peakHour: { hour: number; movements: number; departingPax: number };
  terminalRows: { terminalId: string; checkInPerHour: number; securityPerHour: number; throughputPerHour: number; peakPaxPerHour: number; bottleneck: 'checkIn' | 'security' | null }[];
  /** ハブ（フェーズ 4 §5.6）: 種類ごとの MCT（分）と波の能力。算出できない値は null のまま */
  hub: {
    mctMin: Record<'DD' | 'DI' | 'ID' | 'II', { max: number | null; median: number | null }>;
    bankAircraft: number | null;
    bankPax: number | null;
    transferPaxPerDay: number;
  };
}

const peak = (values: readonly number[]): number => Math.max(0, ...values);
const statusFor = (capacity: number | null, demand: number | null): CapacityStatus => {
  if (capacity === null || demand === null) return 'uncomputed';
  if (capacity <= 0 && demand > 0) return 'shortage';
  const ratio = capacity > 0 ? demand / capacity : 0;
  return ratio > 1 ? 'shortage' : ratio >= 0.8 ? 'warning' : 'adequate';
};
function metric(name: string, unit: CapacityMetric['unit'], capacity: number | null, demand: number | null, basis: string): CapacityMetric {
  const status = statusFor(capacity, demand);
  const utilization = capacity !== null && capacity > 0 && demand !== null ? demand / capacity : capacity === 0 && demand === 0 ? 0 : null;
  return { name, unit, capacity, demand, utilization, spare: capacity !== null && demand !== null ? Math.max(0, capacity - demand) : null, status, basis };
}
const stateOf = (s: string): CapacityFacilityRow['state'] => s === 'operational' ? 'operational' : s === 'underConstruction' ? 'construction' : 'planned';

function peakConcurrentStands(plan: DayPlan, analysis: PlanAnalysis): { byStand: Map<string, number>; total: number } {
  const points = new Map<string, { t: number; d: number }[]>();
  const totalPoints: { t: number; d: number }[] = [];
  for (const f of plan.flights) {
    const id = analysis.assignments[f.key]?.standId;
    if (!id) continue;
    const p = points.get(id) ?? [];
    p.push({ t: f.arrivalAt + f.inboundDelaySec, d: 1 }, { t: f.departureAt, d: -1 });
    points.set(id, p);
    totalPoints.push({ t: f.arrivalAt + f.inboundDelaySec, d: 1 }, { t: f.departureAt, d: -1 });
  }
  const out = new Map<string, number>();
  for (const [id, ps] of points) {
    ps.sort((a, b) => a.t - b.t || a.d - b.d);
    let now = 0; let max = 0;
    for (const p of ps) { now += p.d; max = Math.max(max, now); }
    out.set(id, max);
  }
  totalPoints.sort((a, b) => a.t - b.t || a.d - b.d);
  let concurrent = 0; let total = 0;
  for (const p of totalPoints) { concurrent += p.d; total = Math.max(total, concurrent); }
  return { byStand: out, total };
}

/** Planned demand and modelled capacities from the same planning rules used by the operations panel. */
/** 運航中の閉鎖（AS-5）。指定した滑走路・スポットは数から除く */
export interface LiveClosures {
  closedRunwayIds: readonly string[];
  closedStandIds: readonly string[];
}

export function analyzeAirportCapacity(company: CompanyState, ctx: SimContext, closedBusGateIds: readonly string[] = [], plan = planDayWithDemand(company, company.day, 1, ctx.types, routeCapabilitiesForAirport(ctx.layout.countryId, { international: internationalProcessingFor(company, ctx.terminal) })), currentPaxByTerminal?: Readonly<Record<string, number>>, live?: LiveClosures): AirportCapacitySnapshot {
  const analysis = analyzeDayPlan(plan, ctx, closedBusGateIds);
  // ハブ（フェーズ 4 §5.6）: 乗継の計画を同じ MCT で付け、波の能力を算出する
  const hubAnalysis = analyzeHub(ctx.layout, ctx.terminal);
  planConnections(plan, company, hubAnalysis);
  const hub = (() => {
    const mctMin = Object.fromEntries(TRANSFER_KINDS.map((kind) => [kind, {
      max: hubAnalysis.byKind[kind].max !== null ? hubAnalysis.byKind[kind].max! / 60 : null,
      median: hubAnalysis.byKind[kind].median !== null ? hubAnalysis.byKind[kind].median! / 60 : null,
    }])) as AirportCapacitySnapshot['hub']['mctMin'];
    const banks = company.hub?.banks ?? [];
    const gateCount = Object.values(ctx.terminal.gates).filter((g) => g.terminalId).length;
    const bankAircraft = banks.length > 0 ? Math.min(analysis.capacity.totalStands, gateCount) : null;
    const tsAreas = Object.values(ctx.layout.terminalAreas).filter((a) => a.kind === 'transferSecurity');
    const tsPerHour = tsAreas.reduce((sum, a) => sum + (Math.max(0, Number(a.props.counters ?? a.props.booths ?? a.props.lanes ?? a.props.fixtures ?? a.props.capacity ?? 0)) * 3600) / serviceSecPerPax(a.kind, a.props), 0);
    const longestBankHours = banks.length > 0 ? Math.max(...banks.map((b) => Math.max(0, (b.departToMin - b.arriveFromMin) / 60))) : 0;
    const bankPax = banks.length > 0 && tsAreas.length > 0 ? Math.floor(tsPerHour * longestBankHours) : null;
    const transferPaxPerDay = plan.flights.reduce((sum, f) => sum + (f.connections ?? []).reduce((s, cn) => s + cn.pax, 0), 0);
    return { mctMin, bankAircraft, bankPax, transferPaxPerDay };
  })();
  // 夜間の運用設定（最終出発時刻）があるときだけ、運用時間の終わりを最終出発時刻で切る（R17）。ないときは従来の値
  const capHours = company.city?.nightOps ? cityOperatingHours(company.hours, company.city) : company.hours;
  const operatingHours = Math.max(0, (capHours.closeMin - capHours.openMin) / 60);
  const peakMovements = peak(analysis.hourly.movements);
  // 消防区分・管制塔（5-05）: 助言的な制限の表示値
  const fireCat = airportFireCategory(ctx.layout);
  const maxRequiredFireCat = plan.flights.reduce((m, f) => Math.max(m, requiredFireCategory(resolveType(ctx.types, f.typeId).lengthM)), 0);
  const towerLvl = towerLevel(ctx.layout);
  const towerCap = towerCapacityPerHour(towerLvl);
  const peakDepartingPax = peak(analysis.hourly.depPax);
  const closedRunways = new Set(live?.closedRunwayIds ?? []);
  const closedStands = new Set(live?.closedStandIds ?? []);
  const liveNote = live ? '。運航中の閉鎖を反映' : '';
  const operationalRunways = Object.values(ctx.runways).filter((r) => r.operational && !closedRunways.has(r.id)).length;
  // 滑走路の能力は構成から算出する（5-01）
  const runwaySystem = runwaySystemCapacity(ctx.layout, (r) => (ctx.runways[r.id]?.operational ?? false) && !closedRunways.has(r.id));
  const runwayHourly = runwaySystem.perHour;
  const overnightCount = plan.flights.filter((f) => f.overnight).length;
  const terminalIds = Object.keys(ctx.terminal.byTerminal).sort(compareIds);
  const terminalRows = terminalIds.map((terminalId) => {
    const t = analysis.terminalCapacity[terminalId] ?? { checkInPerHour: 0, securityPerHour: 0 };
    const hourly = analysis.hourlyByTerminal[terminalId] ?? [];
    const throughput = t.checkInPerHour > 0 && t.securityPerHour > 0 ? Math.min(t.securityPerHour, t.checkInPerHour / CHECKIN_SHARE) : 0;
    const peakPaxPerHour = peak(hourly);
    return { terminalId, checkInPerHour: t.checkInPerHour, securityPerHour: t.securityPerHour, throughputPerHour: throughput, peakPaxPerHour, bottleneck: t.checkInPerHour / CHECKIN_SHARE <= t.securityPerHour ? 'checkIn' as const : 'security' as const };
  });
  const totalTerminalThroughput = terminalRows.reduce((sum, t) => sum + t.throughputPerHour, 0);
  const peakTerminalDemand = Math.max(0, ...Array.from({ length: 24 }, (_, h) => terminalRows.reduce((sum, t) => sum + (analysis.hourlyByTerminal[t.terminalId]?.[h] ?? 0), 0)));
  const totalCheckin = terminalRows.reduce((sum, t) => sum + t.checkInPerHour, 0);
  const totalSecurity = terminalRows.reduce((sum, t) => sum + t.securityPerHour, 0);
  const terminalOccupancyCapacity = terminalIds.reduce((sum, id) => sum + (ctx.terminal.byTerminal[id] ?? []).reduce((areaSum, areaId) => areaSum + (ctx.terminal.areas[areaId]?.capacity ?? 0), 0), 0);
  const currentOccupancy = currentPaxByTerminal ? Object.values(currentPaxByTerminal).reduce((sum, count) => sum + count, 0) : null;
  const peakTurns = analysis.peakTurnarounds;
  const access = analyzeAccess(ctx.layout, { city: company.city, day: company.day });
  const turns = turnaroundCapacity(ctx);
  const standDemand = peakConcurrentStands(plan, analysis);
  const assignedStandDemand = standDemand.byStand;
  const gateDemand = new Map<string, number[]>();
  const hourOf = (sec: number) => Math.min(23, Math.max(0, Math.floor(sec / 3600)));
  for (const f of plan.flights) {
    const assignment = analysis.assignments[f.key];
    const gateId = assignment?.busGateId ?? assignment?.gateId;
    if (!gateId) continue;
    const hourly = gateDemand.get(gateId) ?? Array.from({ length: 24 }, () => 0);
    hourly[hourOf(f.departureAt - 90 * 60)]! += f.depPax;
    gateDemand.set(gateId, hourly);
  }
  const liveStands = Object.values(ctx.stands).filter((s) => s.operational && s.entry && !closedStands.has(s.id));
  const availableStands = liveStands.length;
  const contactStands = liveStands.filter((s) => s.contact).length;
  const remoteStands = liveStands.filter((s) => !s.contact).length;
  // スポットの回転数（AS-4）= 運用中スポット数 ÷ 計画の平均占有時間（降機〜出発＋スポット間隔）× 2（到着・出発）。計画が空なら未算出
  const occupancyHours = plan.flights.length > 0 ? plan.flights.reduce((sum, f) => sum + (f.departureAt - f.arrivalAt + STAND_GAP_SEC), 0) / plan.flights.length / 3600 : 0;
  const standTurnover = occupancyHours > 0 ? (availableStands / occupancyHours) * 2 : null;
  // 折り返し能力 × 2 ÷ 平均の折り返し時間（到着〜出発）。計画が空なら未算出
  const turnaroundHours = plan.flights.length > 0 ? plan.flights.reduce((sum, f) => sum + (f.departureAt - f.arrivalAt), 0) / plan.flights.length / 3600 : 0;
  const turnaroundMovements = turnaroundHours > 0 ? (turns * 2) / turnaroundHours : null;
  const overallParts = ([['runway', runwayHourly], ['stand', standTurnover], ['turnaround', turnaroundMovements]] as const).filter((x): x is readonly ['runway' | 'stand' | 'turnaround', number] => x[1] !== null);
  const overallMin = overallParts.length > 0 ? overallParts.reduce((best, x) => (x[1] < best[1] ? x : best)) : null;
  const overall: AirportCapacitySnapshot['overall'] = { capacity: overallMin ? overallMin[1] : null, limitedBy: overallMin ? overallMin[0] : null };
  // 空港アクセスの合計（AC-1）= 使える手段の capacityPerHour の合計。1 つでも null（能力が算出できない手段）があれば未算出
  const usableModes = ACCESS_MODES.filter((m) => access.modes[m].available);
  const nullModes = usableModes.filter((m) => access.modes[m].capacityPerHour === null);
  const accessTotalPerHour = usableModes.length > 0 && nullModes.length === 0 ? usableModes.reduce((sum, m) => sum + (access.modes[m].capacityPerHour ?? 0), 0) : null;
  const MODE_NAME: Record<(typeof ACCESS_MODES)[number], string> = { car: '自家用車', dropoff: '送迎', taxi: 'タクシー', bus: 'バス', rail: '鉄道', walk: '徒歩' };
  const accessBasis = usableModes.length === 0
    ? '使える手段がない'
    : nullModes.length > 0
      ? `能力が算出できない手段があるため合計は未算出（${nullModes.map((m) => MODE_NAME[m]).join('・')}）。使える手段: ${usableModes.map((m) => MODE_NAME[m]).join('・')}`
      : `使える手段の時間あたり能力の合計（${usableModes.map((m) => MODE_NAME[m]).join('・')}）。需要・実績は未算出`;
  const peakStandUse = standDemand.total;
  const buses = ctx.bases.reduce((sum, b) => sum + (b.units.apronBus ?? 0), 0);
  const summary = [
    metric('滑走路', 'movements/h', runwayHourly, peakMovements, `滑走路の構成から算出（${runwaySystem.basis}）。稼働 ${operationalRunways} 本、日計は運用時間 ${operatingHours.toFixed(1)} 時間を使用${liveNote}`),
    metric('スポット同時駐機', 'aircraft', availableStands, peakStandUse, `運用中・誘導路接続済み ${availableStands} 箇所（直結 ${contactStands} / リモート ${remoteStands}）。需要は計画割当の同時駐機ピーク${liveNote}`),
    // フェーズ 4 §3.4: 朝の 1 時間に出せる始発の数（能力は滑走路の時間能力を流用。滞泊の計画がない日は未算出）
    metric('朝の始発（1 時間）', 'movements/h', overnightCount > 0 ? runwayHourly : null, overnightCount > 0 ? overnightCount : null, overnightCount > 0 ? `滞泊の出発 ${overnightCount} 便が朝の波を作る。能力は滑走路の時間能力 ${runwayHourly} 回/時を流用（地上走行の競合は含めない）` : '滞泊の契約がないため未算出'),
    metric('ターミナル全体', 'pax/h', terminalRows.length ? totalTerminalThroughput : null, peakTerminalDemand, 'ターミナルごとのチェックイン能力÷利用率と保安検査能力の小さい方を合算。経路未割当の旅客は含めない'),
    metric('ターミナル最大収容人数', 'pax', terminalOccupancyCapacity, currentOccupancy, '既存 TerminalModel の各エリア容量（面積基準）を合算。現在人数は運航中の未完了旅客グループから算出'),
    metric('チェックイン', 'pax/h', totalCheckin, peakDepartingPax * CHECKIN_SHARE, `配置カウンター数 × 3600 ÷ 各施設の処理秒数。計画旅客の ${Math.round(CHECKIN_SHARE * 100)}% が利用`),
    metric('保安検査', 'pax/h', totalSecurity, peakDepartingPax, '稼働レーン数 × 3600 ÷ 各施設の処理秒数'),
    metric('地上支援・折り返し', 'aircraft', turns, peakTurns, '既存 turnaroundCapacity の人員・車両制約による同時処理上限。時間当たり換算は未算出'),
    metric('プッシュバック', 'aircraft', null, null, '実際のタスク所要時間・車両の共有予約を統合した処理率が未モデル化'),
    metric('誘導路', 'movements/h', null, null, '地上走行経路の競合・占有を時間当たり能力へ換算するモデルが未実装'),
    metric('搭乗バス', 'pax/h', null, null, `運用中バス ${buses} 台、1便あたりの定員 ${APRON_BUS_CAPACITY} 人。往復経路時間と運行便ごとの競合を含む時間能力は未算出`),
    metric('駅からターミナルへの連絡通路', 'pax/h', access.railWalkCapacityPerHour, null, access.railWalkCapacityPerHour === null ? '歩行路の実経路は接続確認するが、全区間に明示能力がないため処理人数は未算出' : '地下・地上・高架の運用歩行路の最小明示能力。乗客実績の需要は未算出'),
    metric('1日総処理（滑走路・理論値）', 'movements/day', runwayHourly > 0 ? runwayHourly * operatingHours : 0, plan.flights.length * 2, `滑走路の時間能力 × 運用時間 ${operatingHours.toFixed(1)} h。ピーク偏在や滑走路構成・閉鎖は別途確認が必要`),
    metric('1日旅客処理（理論値）', 'pax/day', totalTerminalThroughput > 0 ? totalTerminalThroughput * operatingHours : null, plan.flights.reduce((sum, f) => sum + f.arrPax + f.depPax, 0), `ターミナル工程ボトルネック × 運用時間 ${operatingHours.toFixed(1)} h。便の集中を反映しない理論値`),
    metric('消防区分', 'units', fireCat > 0 ? fireCat : null, maxRequiredFireCat > 0 ? maxRequiredFireCat : null, fireCat > 0 ? `消防施設の区分（最大 ${fireCat}）。需要は計画便の機体長から求めた必要区分の最大。不足しても運航は止まらない（助言的な制限、5-05）` : '消防施設がないため未算出'),
    metric('管制塔', 'movements/h', towerCap > 0 ? towerCap : null, peakMovements, towerCap > 0 ? `管制塔レベル ${towerLvl} の処理能力の目安。需要は計画のピーク 1 時間の発着回数。超過しても運航は止まらない（助言的な制限、5-05）` : '管制塔がないため未算出'),
    metric('スポットの回転数', 'movements/h', standTurnover, peakMovements, standTurnover === null ? '計画の便がないため平均占有時間が求められず未算出' : `運用中スポット ${availableStands} 箇所 ÷ 計画の平均占有時間 ${occupancyHours.toFixed(2)} 時間（降機〜出発＋スポット間隔 ${STAND_GAP_SEC / 60} 分）× 2（到着・出発）${liveNote}`),
    metric('空港全体の離発着能力', 'movements/h', overall.capacity, peakMovements, `滑走路・スポットの回転数・折り返し能力（折り返し能力 × 2 ÷ 平均の折り返し時間${turnaroundHours > 0 ? ` ${turnaroundHours.toFixed(2)} 時間` : ''}）の最小。制約: ${overall.limitedBy === 'runway' ? '滑走路' : overall.limitedBy === 'stand' ? 'スポットの回転数' : overall.limitedBy === 'turnaround' ? '折り返し能力' : '未算出'}。誘導路は能力が未算出のため含めない${standTurnover === null ? '（計画の便がないためスポット・折り返しは未算出）' : ''}${liveNote}`),
    metric('空港アクセス（合計）', 'pax/h', accessTotalPerHour, null, accessBasis),
    metric('空港アクセス（合計・1日）', 'pax/day', accessTotalPerHour !== null ? accessTotalPerHour * operatingHours : null, null, `${accessBasis}。運用時間 ${operatingHours.toFixed(1)} h を掛けた理論値`),
  ];
  const facilities: CapacityFacilityRow[] = [];
  for (const r of Object.values(ctx.layout.runways).sort((a, b) => compareIds(a.id, b.id))) {
    const open = r.buildState === 'operational' && !closedRunways.has(r.id);
    facilities.push({ id: r.id, name: r.name, kind: '滑走路', state: stateOf(r.buildState), capacity: open ? RUNWAY_HOURLY_CAPACITY : 0, demand: null, unit: 'movements/h', status: open ? 'uncomputed' : 'shortage', basis: open ? `計画基準 ${RUNWAY_HOURLY_CAPACITY} 回/時。便ごとの滑走路割当需要は未算出` : r.buildState === 'operational' ? '運航中の閉鎖' : '運用状態ではない' });
  }
  // 誘導路: 区間ごとの走行（taxiMode 'block'）のときだけ能力を出す（plan 2-08）。従来方式は未算出のまま
  const blockTaxiSpeed = ctx.blocks ? resolveType(ctx.types, 'narrow180').taxiSpeed : 0;
  for (const e of Object.values(ctx.layout.taxiways).sort((a, b) => compareIds(a.id, b.id))) {
    const open = e.buildState === 'operational';
    const perHour = ctx.blocks && open ? taxiwayCapacityPerHour(ctx.blocks, [e.id], 'M', blockTaxiSpeed) : null;
    facilities.push({
      id: e.id, name: e.name, kind: '誘導路', state: stateOf(e.buildState), capacity: perHour === null ? null : Math.round(perHour * 10) / 10, demand: null, unit: 'movements/h', status: 'uncomputed',
      basis: !open ? '運用状態ではない'
        : perHour !== null ? `区間ごとの走行。M 機の通行能力 = min(進入可能機数 × 3600 ÷ 通過時間, 3600 × 地上走行速度 ÷ 必要長 ${BLOCK_REQ_M.M} m) の含む区間の最小（地上走行速度 ${blockTaxiSpeed} m/s）。需要・実績は未算出`
          : ctx.blocks ? '区間ごとの走行。この誘導路は能力を持つ区間がない（滑走路手前の小片のみ）。需要・実績は未算出'
            : '経路・閉鎖状態はシミュレーションで判定。時間当たり能力は未算出',
    });
  }
  for (const e of Object.values(ctx.layout.roads).sort((a, b) => compareIds(a.id, b.id))) {
    const a = ctx.layout.roadNodes[e.from];
    const b = ctx.layout.roadNodes[e.to];
    const levels = [...new Set([a?.level ?? 0, b?.level ?? 0])].sort((x, y) => x - y).join(' ↔ ');
    const unit: CapacityMetric['unit'] = e.roadClass === 'walkway' ? 'pax/h' : e.roadClass === 'rail' ? 'trains/h' : e.roadClass === 'fuel' ? 'fuel/h' : 'vehicles/h';
    const label = e.roadClass === 'walkway' ? '歩行通路' : e.roadClass === 'rail' ? '鉄道線路' : e.roadClass === 'fuel' ? '燃料管' : e.roadClass === 'service' ? '構内道路' : '一般道路';
    facilities.push({ id: e.id, name: e.name || e.id, kind: label, state: stateOf(e.buildState), capacity: e.capacityPerHour ?? null, demand: null, unit, status: 'uncomputed', basis: `階層 ${levels}${e.connectorKind ? `・接続 ${e.connectorKind}` : ''}。${e.capacityPerHour === undefined ? '明示能力なし' : `設定能力 ${e.capacityPerHour} ${unitLabelFor(unit)}`}。${e.roadClass === 'walkway' ? '旅客の駅接続経路検証に使用' : e.roadClass === 'fuel' ? '到達可能なスポットでは燃料車を使わない作業として反映' : '個別の車両・列車走行需要と占有は未モデル化'}。需要・稼働率は未算出` });
  }
  for (const s of Object.values(ctx.layout.stands).sort((a, b) => compareIds(a.id, b.id))) {
    const operational = ctx.stands[s.id]?.operational && !!ctx.stands[s.id]?.entry && !closedStands.has(s.id);
    facilities.push({ id: s.id, name: s.name, kind: ctx.stands[s.id]?.contact ? '直結スポット' : 'リモートスポット', state: stateOf(s.buildState), capacity: operational ? 1 : 0, demand: assignedStandDemand.get(s.id) ?? 0, unit: 'aircraft', status: statusFor(operational ? 1 : 0, assignedStandDemand.get(s.id) ?? 0), basis: operational ? '同時駐機 1 機。リモートスポットは搭乗バスの時間能力を別途算出できない' : closedStands.has(s.id) ? '運航中の閉鎖のため利用不可' : '閉鎖・未接続・建設中のため計画上利用不可' });
  }
  for (const t of terminalRows) facilities.push({ id: t.terminalId, name: ctx.layout.facilities[t.terminalId]?.name ?? t.terminalId, kind: 'ターミナル', state: stateOf(ctx.layout.facilities[t.terminalId]?.buildState ?? 'planned'), terminalId: t.terminalId, capacity: t.throughputPerHour, demand: t.peakPaxPerHour, unit: 'pax/h', status: statusFor(t.throughputPerHour, t.peakPaxPerHour), basis: `ボトルネック: ${t.bottleneck === 'checkIn' ? 'チェックイン' : '保安検査'}。接続済み計画旅客だけで算出` });
  for (const a of Object.values(ctx.layout.terminalAreas).sort((x, y) => compareIds(x.id, y.id))) {
    if (a.kind !== 'checkIn' && a.kind !== 'security') continue;
    const servers = Number(a.props.counters ?? a.props.lanes ?? 0);
    const cap = Math.round(servers * 3600 / serviceSecPerPax(a.kind, a.props));
    facilities.push({ id: a.id, name: a.name, kind: a.kind === 'checkIn' ? 'チェックインカウンター' : '保安検査場', state: stateOf(ctx.layout.facilities[a.terminalId]?.buildState ?? 'planned'), terminalId: a.terminalId, capacity: cap, demand: null, unit: 'pax/h', status: cap > 0 ? 'uncomputed' : 'shortage', basis: `${servers} レーン/カウンター × 3600 ÷ ${serviceSecPerPax(a.kind, a.props)} 秒/人。施設別の時間帯割当需要は未算出` });
  }
  for (const link of Object.values(ctx.layout.terminalLinks ?? {}).sort((a, b) => compareIds(a.id, b.id))) {
    const from = ctx.layout.terminalAreas[link.fromAreaId];
    const to = ctx.layout.terminalAreas[link.toAreaId];
    facilities.push({ id: link.id, name: link.name || link.id, kind: link.kind === 'movingWalkway' ? '動く歩道' : 'ターミナル間通路', state: stateOf(link.buildState), terminalId: from?.terminalId, capacity: terminalLinkCapacityPerHour(link), demand: null, unit: 'pax/h', status: 'uncomputed', basis: `${from?.terminalId ?? '?'} → ${to?.terminalId ?? '?'}・${link.bidirectional ? '双方向' : '片方向'}・${link.travelSec} 秒 / ${link.distanceM} m・対象区域 ${link.allowedZones.join(', ')}。${link.capacityPerHour === undefined ? `明示容量は未設定（運航では既定値 ${terminalLinkCapacityPerHour(link)} 人/時を使用）` : `明示容量 ${link.capacityPerHour} 人/時`}。利用人数は現行旅客シミュレーションで記録していないため未算出` });
  }
  for (const f of Object.values(ctx.layout.facilities).sort((a, b) => compareIds(a.id, b.id))) {
    if (f.kind === 'gate') {
      const gate = ctx.terminal.gates[f.id];
      const demand = peak(gateDemand.get(f.id) ?? []);
      facilities.push({ id: f.id, name: f.name, kind: f.props.boardingMode === 'bus' ? 'バスゲート' : '搭乗ゲート', state: stateOf(f.buildState), terminalId: gate?.terminalId ?? undefined, capacity: null, demand, unit: 'pax/h', status: 'uncomputed', basis: `ターミナル接続: ${gate?.terminalId ?? '未接続'}。時間帯別の計画割当需要は表示するが、ゲート処理率は未モデル化` });
    } else if (f.kind === 'railStation') {
      const trainsPerHour = Number(f.props.trainsPerHour ?? 0);
      facilities.push({ id: f.id, name: f.name, kind: '鉄道駅', state: stateOf(f.buildState), capacity: trainsPerHour > 0 ? trainsPerHour : null, demand: null, unit: 'trains/h', status: 'uncomputed', basis: `階層 ${Number(f.props.level ?? 0)}。設定された運行頻度 ${trainsPerHour || '未設定'} 本/時であり、線路・ホームの実処理能力や乗客実績は未算出` });
    } else if (f.kind === 'gseBase' || f.kind === 'maintenance') {
      const counts = Object.entries(f.props).filter(([k, v]) => ['staff', 'tugs', 'beltLoaders', 'baggageTractors', 'fuelTrucks', 'cateringTrucks', 'cleaningVans', 'apronBuses', 'engineers'].includes(k) && typeof v === 'number').map(([k, v]) => `${k} ${v}`).join(' / ') || '設備数なし';
      facilities.push({ id: f.id, name: f.name, kind: f.kind === 'gseBase' ? '地上支援設備' : '整備設備', state: stateOf(f.buildState), capacity: null, demand: null, unit: 'units', status: 'uncomputed', basis: `${counts}。ターン能力は空港全体で共有リソースの最小値から算出し、施設単位には配賦しない` });
    }
  }
  // 空港アクセスの施設（AC-2）: 容量は analyzeAccess の既存値。需要・実績は未算出
  facilities.push({ id: 'access:entrances', name: '一般車の出入口', kind: '出入口', state: 'operational', capacity: access.entrances > 0 ? access.roadCapacityPerHour : null, demand: null, unit: 'vehicles/h', status: 'uncomputed', basis: `敷地の外へつながる一般道路 ${access.entrances} 本 × ${BALANCE.accessModel.roadPerEntrance} 台/時。需要・実績は未算出` });
  facilities.push({ id: 'access:curb', name: '車寄せ', kind: '車寄せ', state: 'operational', capacity: access.curbCapacityPerHour > 0 ? access.curbCapacityPerHour : null, demand: null, unit: 'vehicles/h', status: 'uncomputed', basis: `ターミナルに接する一般道路のタイル × ${BALANCE.accessModel.curbPerTile} 台/時。需要・実績は未算出` });
  const usableAccess = new Set(ACCESS_MODES.flatMap((m) => access.modes[m].facilities));
  for (const f of Object.values(ctx.layout.facilities).sort((a, b) => compareIds(a.id, b.id))) {
    if (f.kind !== 'parking' && f.kind !== 'busStop' && f.kind !== 'busTerminal' && f.kind !== 'taxiStand') continue;
    const used = f.buildState === 'operational' && usableAccess.has(f.id);
    const M = BALANCE.accessModel;
    const value = f.kind === 'parking'
      ? { cap: Number(f.props.spaces ?? 0), unit: 'units' as const, text: `駐車 ${Number(f.props.spaces ?? 0)} 台` }
      : f.kind === 'busStop' || f.kind === 'busTerminal'
        ? (() => { const perHour = Math.min(Number(f.props.busesPerHour ?? 0), Number((f.kind === 'busTerminal' ? f.props.berths : f.props.busBays) ?? 0) * M.busesPerBay); return { cap: perHour * M.busSeats, unit: 'pax/h' as const, text: `バス ${perHour} 便/時 × ${M.busSeats} 人` }; })()
        : { cap: Number(f.props.berths ?? 0) * M.taxiPaxPerBerth, unit: 'pax/h' as const, text: `乗車枠 ${Number(f.props.berths ?? 0)} × ${M.taxiPaxPerBerth} 人/時` };
    facilities.push({ id: f.id, name: f.name, kind: f.kind === 'parking' ? '駐車場' : f.kind === 'busStop' ? 'バス乗り場' : f.kind === 'busTerminal' ? 'バスターミナル' : 'タクシー乗り場', state: stateOf(f.buildState), capacity: used ? value.cap : null, demand: null, unit: value.unit, status: 'uncomputed', basis: used ? `${value.text}。需要・実績は未算出` : `${f.buildState === 'operational' ? '外部道路への接続・ターミナルからの距離の条件を満たさず、アクセス手段として使われていない' : '運用状態ではない'}。容量は未算出` });
  }
  const peakHour = analysis.hourly.movements.reduce((best, movements, hour) => movements > best.movements ? { hour, movements, departingPax: analysis.hourly.depPax[hour] ?? 0 } : best, { hour: 0, movements: 0, departingPax: 0 });
  const bottlenecks = summary.filter((m) => m.status === 'shortage' || m.status === 'warning').sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0));
  return { plan, analysis, operatingHours, summary, overall, bottlenecks, facilities, peakHour, terminalRows, hub };
}

const unitLabelFor = (unit: CapacityMetric['unit']): string => ({ 'movements/h': '回/時', 'movements/day': '回/日', aircraft: '機', pax: '人', 'pax/h': '人/時', 'pax/day': '人/日', 'aircraft/day': '機/日', units: '台・人', 'pax/trip': '人/便', 'vehicles/h': '台/時', 'trains/h': '本/時', 'fuel/h': '単位/時' })[unit];

export interface CapacityPreviewInput {
  airlineId: string;
  destinationId: string;
  typeId: string;
  perDay: number;
  window: TimeWindow;
  /** フェーズ 4: 滞泊・拠点の契約は滞泊の能力も合わせて判定する */
  kind?: Contract['kind'];
  basedAircraft?: number;
}
export interface CapacityPreview {
  result: 'acceptable' | 'conditional' | 'unacceptable';
  before: AirportCapacitySnapshot;
  after: AirportCapacitySnapshot;
  newIssues: PlanAnalysis['issues'];
  reason: string;
}

function newlyIntroducedIssues(before: PlanAnalysis, after: PlanAnalysis): PlanAnalysis['issues'] {
  const existing = new Map(before.issues.map((issue) => [`${issue.code}:${issue.detail ?? ''}`, new Set(issue.keys)]));
  return after.issues
    .map((issue) => ({ ...issue, keys: issue.keys.filter((key) => !existing.get(`${issue.code}:${issue.detail ?? ''}`)?.has(key)) }))
    .filter((issue) => issue.keys.length > 0);
}

/** Add a temporary contract to a deep copy; no company, layout, save slot, or running simulation is mutated. */
/** 投資効果のプレビュー（5-04 / B4）: 2 つの能力スナップショットの差分（容量が変わった指標だけ） */
export interface CapacityDelta {
  name: string;
  unit: CapacityMetric['unit'];
  before: number | null;
  after: number | null;
  delta: number | null;
}

export function capacityDelta(before: AirportCapacitySnapshot, after: AirportCapacitySnapshot): CapacityDelta[] {
  const prev = new Map(before.summary.map((m) => [m.name, m]));
  const out: CapacityDelta[] = [];
  for (const m of after.summary) {
    const b = prev.get(m.name)?.capacity ?? null;
    if (b === m.capacity) continue;
    out.push({ name: m.name, unit: m.unit, before: b, after: m.capacity, delta: b !== null && m.capacity !== null ? m.capacity - b : null });
  }
  return out;
}

export function previewContractCapacity(company: CompanyState, ctx: SimContext, input: CapacityPreviewInput, closedBusGateIds: readonly string[] = [], access = 1): CapacityPreview {
  const routeCapabilities = routeCapabilitiesForAirport(ctx.layout.countryId, { international: internationalProcessingFor(company, ctx.terminal) });
  const beforePlan = planDayWithDemand(company, company.day, access, ctx.types, routeCapabilities);
  const before = analyzeAirportCapacity(company, ctx, closedBusGateIds, beforePlan);
  const copy = structuredClone(company);
  const contract: Omit<Contract, 'id' | 'numberBase'> = {
    airlineId: input.airlineId,
    destinationId: input.destinationId,
    typeId: input.typeId as Contract['typeId'],
    perDay: Math.max(1, Math.min(20, Math.floor(input.perDay))),
    window: input.window,
    feeDiscount: 0,
    startDay: company.day,
    endDay: company.day,
    status: 'active',
    offerExpiresDay: company.day,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.basedAircraft !== undefined ? { basedAircraft: input.basedAircraft } : {}),
  };
  addContract(copy, contract);
  const afterPlan = planDayWithDemand(copy, copy.day, access, ctx.types, routeCapabilities);
  const after = analyzeAirportCapacity(copy, ctx, closedBusGateIds, afterPlan);
  const newIssues = newlyIntroducedIssues(before.analysis, after.analysis);
  const newErrors = newIssues.filter((i) => i.severity === 'error');
  const addedWarnings = newIssues.filter((i) => i.severity === 'warning');
  const result: CapacityPreview['result'] = newErrors.length ? 'unacceptable' : addedWarnings.length ? 'conditional' : 'acceptable';
  const reason = newErrors.length ? `新たな運航不能 ${newErrors.length} 件（例: ${newErrors[0]!.code}）` : addedWarnings.length ? `新たな能力警告 ${addedWarnings.length} 件。追加需要と施設計画を確認してください` : operableTypes(ctx).includes(input.typeId) ? '追加便による新規の運航不能・能力警告はありません' : '選択機材は現在の空港で運航できません';
  return { result: !operableTypes(ctx).includes(input.typeId) ? 'unacceptable' : result, before, after, newIssues, reason };
}

/** Increase one existing route by a single daily round-trip on a clone and reject only newly fatal constraints. */
export function previewFrequencyCapacity(
  company: CompanyState,
  ctx: SimContext,
  contractId: string,
  closedBusGateIds: readonly string[] = [],
  access = 1,
): CapacityPreview {
  const routeCapabilities = routeCapabilitiesForAirport(ctx.layout.countryId, { international: internationalProcessingFor(company, ctx.terminal) });
  const beforePlan = planDayWithDemand(company, company.day, access, ctx.types, routeCapabilities);
  const before = analyzeAirportCapacity(company, ctx, closedBusGateIds, beforePlan);
  const copy = structuredClone(company);
  const contract = copy.contracts[contractId];
  if (!contract || contract.status !== 'active') {
    return { result: 'unacceptable', before, after: before, newIssues: [], reason: '増便対象の契約が見つからないか、契約中ではありません' };
  }
  contract.perDay += 1;
  const afterPlan = planDayWithDemand(copy, copy.day, access, ctx.types, routeCapabilities);
  const after = analyzeAirportCapacity(copy, ctx, closedBusGateIds, afterPlan);
  const newIssues = newlyIntroducedIssues(before.analysis, after.analysis);
  const newErrors = newIssues.filter((issue) => issue.severity === 'error');
  const addedWarnings = newIssues.filter((issue) => issue.severity === 'warning');
  const result: CapacityPreview['result'] = newErrors.length ? 'unacceptable' : addedWarnings.length ? 'conditional' : 'acceptable';
  const reason = newErrors.length
    ? `増便による新たな運航不能 ${newErrors.length} 件（例: ${newErrors[0]!.code}）`
    : addedWarnings.length ? `増便による能力警告 ${addedWarnings.length} 件`
      : 'この増便による新規の運航不能・能力警告はありません';
  return { result, before, after, newIssues, reason };
}

export function airportCapacityLabel(layout: AirportLayout, id: string): string {
  return layout.facilities[id]?.name ?? layout.runways[id]?.name ?? layout.stands[id]?.name ?? layout.taxiways[id]?.name ?? id;
}

// ---------------------------------------------------------------- 夜間滞泊の能力（フェーズ 4 §3.4）

export type SizeClass3 = 'S' | 'M' | 'L';
const SIZE_RANK3: Record<SizeClass3, number> = { S: 1, M: 2, L: 3 };

/**
 * 滞泊できる機数（大きさ別）: 運用中で誘導路につながったスポット（リモートを含む）に、
 * 大きい順（L → M → S）に貪欲に割り当てたときの大きさ別の最大機数。
 */
export function overnightCapacity(ctx: SimContext, closures: readonly string[] = []): Record<SizeClass3, number> {
  const stands = Object.values(ctx.stands).filter((s) => s.operational && s.entry && !closures.includes(s.id));
  const fits = (size: SizeClass3) => stands.filter((st) => SIZE_RANK3[st.size] >= SIZE_RANK3[size]).length;
  return { L: fits('L'), M: fits('M'), S: fits('S') };
}

/** 必要機数（大きさ別）が滞泊の能力に収まるか（大きい順の貪欲な割り当てで判定） */
export function overnightFeasible(ctx: SimContext, required: Partial<Record<SizeClass3, number>>, closures: readonly string[] = []): boolean {
  const stands = Object.values(ctx.stands)
    .filter((s) => s.operational && s.entry && !closures.includes(s.id))
    .sort((a, b) => SIZE_RANK3[a.size] - SIZE_RANK3[b.size] || compareIds(a.id, b.id));
  const used = new Set<string>();
  for (const size of ['L', 'M', 'S'] as const) {
    let need = required[size] ?? 0;
    for (const st of stands) {
      if (need <= 0) break;
      if (used.has(st.id) || SIZE_RANK3[st.size] < SIZE_RANK3[size]) continue;
      used.add(st.id);
      need--;
    }
    if (need > 0) return false;
  }
  return true;
}

/** 会社の有効な overnight・based 契約の 1 晩の必要機数（大きさ別） */
export function overnightRequired(company: CompanyState, ctx: SimContext, day: number): Partial<Record<SizeClass3, number>> {
  const out: Partial<Record<SizeClass3, number>> = {};
  for (const k of Object.values(company.contracts)) {
    if (k.status !== 'active' || day < k.startDay || day > k.endDay) continue;
    const n = k.kind === 'overnight' ? k.perDay : k.kind === 'based' ? (k.basedAircraft ?? 1) : 0;
    if (n <= 0) continue;
    const size = resolveType(ctx.types, k.typeId).size as SizeClass3;
    out[size] = (out[size] ?? 0) + n;
  }
  return out;
}
