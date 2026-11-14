import type { AirportLayout } from '../model/types';
import { compareIds } from '../model/ids';
import { serviceSecPerPax } from '../terminal/capacity';
import { analyzeAccess } from '../access/model';
import { APRON_BUS_CAPACITY } from '../sim/busRules';
import type { SimContext } from '../sim/context';
import { operableTypes } from '../sim/context';
import type { CompanyState, Contract, TimeWindow } from './company';
import { addContract } from './company';
import {
  analyzeDayPlan,
  CHECKIN_SHARE,
  planDayWithDemand,
  RUNWAY_HOURLY_CAPACITY,
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
  bottlenecks: CapacityMetric[];
  facilities: CapacityFacilityRow[];
  peakHour: { hour: number; movements: number; departingPax: number };
  terminalRows: { terminalId: string; checkInPerHour: number; securityPerHour: number; throughputPerHour: number; peakPaxPerHour: number; bottleneck: 'checkIn' | 'security' | null }[];
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
export function analyzeAirportCapacity(company: CompanyState, ctx: SimContext, closedBusGateIds: readonly string[] = [], plan = planDayWithDemand(company, company.day, 1, ctx.types), currentPaxByTerminal?: Readonly<Record<string, number>>): AirportCapacitySnapshot {
  const analysis = analyzeDayPlan(plan, ctx, closedBusGateIds);
  const operatingHours = Math.max(0, (company.hours.closeMin - company.hours.openMin) / 60);
  const peakMovements = peak(analysis.hourly.movements);
  const peakDepartingPax = peak(analysis.hourly.depPax);
  const operationalRunways = Object.values(ctx.runways).filter((r) => r.operational).length;
  const runwayHourly = operationalRunways * RUNWAY_HOURLY_CAPACITY;
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
  const availableStands = Object.values(ctx.stands).filter((s) => s.operational && s.entry).length;
  const contactStands = Object.values(ctx.stands).filter((s) => s.operational && s.entry && s.contact).length;
  const remoteStands = Object.values(ctx.stands).filter((s) => s.operational && s.entry && !s.contact).length;
  const peakStandUse = standDemand.total;
  const buses = ctx.bases.reduce((sum, b) => sum + (b.units.apronBus ?? 0), 0);
  const summary = [
    metric('滑走路', 'movements/h', runwayHourly, peakMovements, `稼働滑走路 ${operationalRunways} 本 × 計画基準 ${RUNWAY_HOURLY_CAPACITY} 回/時。日計は運用時間 ${operatingHours.toFixed(1)} 時間を使用`),
    metric('スポット同時駐機', 'aircraft', availableStands, peakStandUse, `運用中・誘導路接続済み ${availableStands} 箇所（直結 ${contactStands} / リモート ${remoteStands}）。需要は計画割当の同時駐機ピーク`),
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
  ];
  const facilities: CapacityFacilityRow[] = [];
  for (const r of Object.values(ctx.layout.runways).sort((a, b) => compareIds(a.id, b.id))) {
    facilities.push({ id: r.id, name: r.name, kind: '滑走路', state: stateOf(r.buildState), capacity: r.buildState === 'operational' ? RUNWAY_HOURLY_CAPACITY : 0, demand: null, unit: 'movements/h', status: r.buildState === 'operational' ? 'uncomputed' : 'shortage', basis: r.buildState === 'operational' ? `計画基準 ${RUNWAY_HOURLY_CAPACITY} 回/時。便ごとの滑走路割当需要は未算出` : '運用状態ではない' });
  }
  for (const e of Object.values(ctx.layout.taxiways).sort((a, b) => compareIds(a.id, b.id))) facilities.push({ id: e.id, name: e.name, kind: '誘導路', state: stateOf(e.buildState), capacity: null, demand: null, unit: 'movements/h', status: 'uncomputed', basis: e.buildState === 'operational' ? '経路・閉鎖状態はシミュレーションで判定。時間当たり能力は未算出' : '運用状態ではない' });
  for (const e of Object.values(ctx.layout.roads).sort((a, b) => compareIds(a.id, b.id))) {
    const a = ctx.layout.roadNodes[e.from];
    const b = ctx.layout.roadNodes[e.to];
    const levels = [...new Set([a?.level ?? 0, b?.level ?? 0])].sort((x, y) => x - y).join(' ↔ ');
    const unit: CapacityMetric['unit'] = e.roadClass === 'walkway' ? 'pax/h' : e.roadClass === 'rail' ? 'trains/h' : e.roadClass === 'fuel' ? 'fuel/h' : 'vehicles/h';
    const label = e.roadClass === 'walkway' ? '歩行通路' : e.roadClass === 'rail' ? '鉄道線路' : e.roadClass === 'fuel' ? '燃料管' : e.roadClass === 'service' ? '構内道路' : '一般道路';
    facilities.push({ id: e.id, name: e.name || e.id, kind: label, state: stateOf(e.buildState), capacity: e.capacityPerHour ?? null, demand: null, unit, status: 'uncomputed', basis: `階層 ${levels}${e.connectorKind ? `・接続 ${e.connectorKind}` : ''}。${e.capacityPerHour === undefined ? '明示能力なし' : `設定能力 ${e.capacityPerHour} ${unitLabelFor(unit)}`}。${e.roadClass === 'walkway' ? '旅客の駅接続経路検証に使用' : e.roadClass === 'fuel' ? '到達可能なスポットでは燃料車を使わない作業として反映' : '個別の車両・列車走行需要と占有は未モデル化'}。需要・稼働率は未算出` });
  }
  for (const s of Object.values(ctx.layout.stands).sort((a, b) => compareIds(a.id, b.id))) {
    const operational = ctx.stands[s.id]?.operational && !!ctx.stands[s.id]?.entry;
    facilities.push({ id: s.id, name: s.name, kind: ctx.stands[s.id]?.contact ? '直結スポット' : 'リモートスポット', state: stateOf(s.buildState), capacity: operational ? 1 : 0, demand: assignedStandDemand.get(s.id) ?? 0, unit: 'aircraft', status: statusFor(operational ? 1 : 0, assignedStandDemand.get(s.id) ?? 0), basis: operational ? '同時駐機 1 機。リモートスポットは搭乗バスの時間能力を別途算出できない' : '閉鎖・未接続・建設中のため計画上利用不可' });
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
    facilities.push({ id: link.id, name: link.name || link.id, kind: link.kind === 'movingWalkway' ? '動く歩道' : 'ターミナル間通路', state: stateOf(link.buildState), terminalId: from?.terminalId, capacity: link.capacityPerHour ?? null, demand: null, unit: 'pax/h', status: 'uncomputed', basis: `${from?.terminalId ?? '?'} → ${to?.terminalId ?? '?'}・${link.bidirectional ? '双方向' : '片方向'}・${link.travelSec} 秒 / ${link.distanceM} m・対象区域 ${link.allowedZones.join(', ')}。明示容量 ${link.capacityPerHour ?? '未設定'} 人/時。利用人数は現行旅客シミュレーションで記録していないため未算出` });
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
  const peakHour = analysis.hourly.movements.reduce((best, movements, hour) => movements > best.movements ? { hour, movements, departingPax: analysis.hourly.depPax[hour] ?? 0 } : best, { hour: 0, movements: 0, departingPax: 0 });
  const bottlenecks = summary.filter((m) => m.status === 'shortage' || m.status === 'warning').sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0));
  return { plan, analysis, operatingHours, summary, bottlenecks, facilities, peakHour, terminalRows };
}

const unitLabelFor = (unit: CapacityMetric['unit']): string => ({ 'movements/h': '回/時', 'movements/day': '回/日', aircraft: '機', pax: '人', 'pax/h': '人/時', 'pax/day': '人/日', 'aircraft/day': '機/日', units: '台・人', 'pax/trip': '人/便', 'vehicles/h': '台/時', 'trains/h': '本/時', 'fuel/h': '単位/時' })[unit];

export interface CapacityPreviewInput {
  airlineId: string;
  destinationId: string;
  typeId: string;
  perDay: number;
  window: TimeWindow;
}
export interface CapacityPreview {
  result: 'acceptable' | 'conditional' | 'unacceptable';
  before: AirportCapacitySnapshot;
  after: AirportCapacitySnapshot;
  newIssues: PlanAnalysis['issues'];
  reason: string;
}

/** Add a temporary contract to a deep copy; no company, layout, save slot, or running simulation is mutated. */
export function previewContractCapacity(company: CompanyState, ctx: SimContext, input: CapacityPreviewInput, closedBusGateIds: readonly string[] = [], access = 1): CapacityPreview {
  const beforePlan = planDayWithDemand(company, company.day, access, ctx.types);
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
  };
  addContract(copy, contract);
  const afterPlan = planDayWithDemand(copy, copy.day, access, ctx.types);
  const after = analyzeAirportCapacity(copy, ctx, closedBusGateIds, afterPlan);
  const existing = new Map(before.analysis.issues.map((i) => [`${i.code}:${i.detail ?? ''}`, new Set(i.keys)]));
  const newIssues = after.analysis.issues.map((i) => ({ ...i, keys: i.keys.filter((k) => !existing.get(`${i.code}:${i.detail ?? ''}`)?.has(k)) })).filter((i) => i.keys.length > 0);
  const newErrors = newIssues.filter((i) => i.severity === 'error');
  const addedWarnings = newIssues.filter((i) => i.severity === 'warning');
  const result: CapacityPreview['result'] = newErrors.length ? 'unacceptable' : addedWarnings.length ? 'conditional' : 'acceptable';
  const reason = newErrors.length ? `新たな運航不能 ${newErrors.length} 件（例: ${newErrors[0]!.code}）` : addedWarnings.length ? `新たな能力警告 ${addedWarnings.length} 件。追加需要と施設計画を確認してください` : operableTypes(ctx).includes(input.typeId) ? '追加便による新規の運航不能・能力警告はありません' : '選択機材は現在の空港で運航できません';
  return { result: !operableTypes(ctx).includes(input.typeId) ? 'unacceptable' : result, before, after, newIssues, reason };
}

export function airportCapacityLabel(layout: AirportLayout, id: string): string {
  return layout.facilities[id]?.name ?? layout.runways[id]?.name ?? layout.stands[id]?.name ?? layout.taxiways[id]?.name ?? id;
}
