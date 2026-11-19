import { Rng, type RngState } from '../rng';
import { compareIds } from '../model/ids';
import { AIRCRAFT_TYPES, resolveType, type AircraftTypeId, type TypeTable } from '../sim/aircraftTypes';
import { BALANCE } from './balance';
import { AIRLINES, HOME_COUNTRY_ID, airlineDef, airlinesFor, destinationDef, destinationsFor, resolveAirlineId, resolveDestinationId, routeAvailability, type DestinationDef, type FleetEntry } from './registry';
import { routeDemand } from './demand';
import { NO_FEEDBACK, type AccessFeedback, type AccessMode } from '../access/model';
import { checkGameSettings, otpAddOf, type GameSettings } from './game';
import { checkAirlineEval, type AirlineEvalState } from './airlineEval';
import { checkMarket, type MarketSettings } from './market';
import type { BasedAircraft, CarryOverAircraft, HubSettings } from './phase4Types';
import { effectiveTier, featureForContractKind, featureOn } from './unlocks';
import { airlineCargoEligible, cargoHoldM3, isLargeFreighter, routeCargoDemandM3 } from './cargo';
import { aircraftIsLow, complaintCount, COMPLAINTS_BLOCK_INCREASE, increaseMinSatRelief, offerBoost, tierBonus } from './evalRules';
import { checkGoals, LEGACY_TIER_MAP, type GoalState } from './goals';
import { isCityConfig, type CityConfig, type CityEvent, type CityType } from './city';
import type { AirlineRequest, RequestKind } from './airlineEval';
import type { ScoreComponent, ScoreKey } from './airlineScore';
import type { MissBreakdownEntry } from '../sim/missBreakdown';

/**
 * 空港会社（経営）の状態。建設モードと運航モードをまたいで保持し、レイアウトと一緒に保存する。
 * docs/14_management_rules.md
 */

export type RevenueCategory = 'contract' | 'landing' | 'parking' | 'terminal' | 'groundHandling' | 'retail' | 'dining' | 'carPark' | 'transit' | 'hotel' | 'cargo';
export type CostCategory =
  | 'salary'
  | 'counterStaff'
  | 'vehicles'
  | 'maintenance'
  | 'utilities'
  | 'accessOps'
  | 'staffCommute'
  | 'groundOps'
  | 'compensation'
  | 'disruption'
  | 'cargoHandling';
export type LedgerCategory = RevenueCategory | CostCategory | 'construction';

export const REVENUE_CATEGORIES: readonly RevenueCategory[] = [
  'contract',
  'landing',
  'parking',
  'terminal',
  'groundHandling',
  'retail',
  'dining',
  'carPark',
  'transit',
  'hotel',
  'cargo',
];
export const COST_CATEGORIES: readonly CostCategory[] = [
  'salary',
  'counterStaff',
  'vehicles',
  'maintenance',
  'utilities',
  'accessOps',
  'staffCommute',
  'groundOps',
  'compensation',
  'disruption',
  'cargoHandling',
];

export type TimeWindow = 'morning' | 'daytime' | 'evening' | 'any';

export type ContractKind = 'turnaround' | 'overnight' | 'based' | 'cargo';

export interface Contract {
  id: string;
  /** 契約の種類（フェーズ 4）。欠落 = turnaround */
  kind?: ContractKind;
  /** 拠点契約: 常駐機数 */
  basedAircraft?: number;
  /** 乗継の受け入れ上限 0〜0.5（フェーズ 4）。実際に乗り継ぐ人数は需要モデルが上限以下で決める（docs/44 §4.2）。欠落 = 0 */
  transferShare?: number;
  /** 乗継の波（バンク）の ID */
  bankId?: string;
  airlineId: string;
  destinationId: string;
  typeId: AircraftTypeId;
  /** 1日あたりの往復便数 */
  perDay: number;
  window: TimeWindow;
  /** 空港使用料の割引率（0〜0.4） */
  feeDiscount: number;
  startDay: number;
  endDay: number;
  status: 'offered' | 'active' | 'ended' | 'rejected' | 'withdrawn' | 'expired';
  /** 提案の有効期限（提案中のみ） */
  offerExpiresDay: number;
  /** 便名の基番号 */
  numberBase: number;
  /** 専用スポット（5-08）: この契約の便が優先して使うスポット。そのスポットに付くゲートも実質占有される */
  dedicatedStandId?: string;
  /** 逆提案を断られた日（5-08。1 日 1 回までの制限に使う） */
  counterRefusedDay?: number;
}

export interface AirlineRelation {
  /** 航空会社の満足度（0〜100） */
  satisfaction: number;
  /** 満足度が撤退水準を下回った連続日数 */
  lowDays: number;
}

export interface FeeSettings {
  /** 基準料金に対する倍率（0.5〜2.0） */
  landing: number;
  terminal: number;
  parking: number;
  /** 空港アクセス（Phase 6）: 駐車料金・タクシー/バス/鉄道の使用料（旅客の運賃に上乗せされる） */
  carPark: number;
  taxi: number;
  bus: number;
  rail: number;
}

export interface OperatingHours {
  /** 運用時間（日内の分）。到着・出発はこの範囲内 */
  openMin: number;
  closeMin: number;
  /** ピーク時間帯（着陸料の割増・計画分析に使う） */
  peaks: { fromMin: number; toMin: number }[];
}

export interface DailyKpi {
  flights: number;
  movements: number;
  paxDeparted: number;
  paxArrived: number;
  /** 定時運航率（0〜1、対象便なしは null） */
  otp: number | null;
  /** 評価用の平均遅延（分）。外部要因と折返し猶予を反映 */
  avgDelayMin: number;
  /** 実時刻と予定時刻の差（分）。評価用遅延と区別する。旧データでは欠落 */
  actualAvgDelayMin?: number;
  runwayUtil: number;
  gateUtil: number;
  facilityUtil: number;
  avgWaitMin: number;
  avgWalkMin: number;
  avgGroundMin: number;
  unprocessedPax: number;
  missedPax: number;
  leftBags: number;
  diverted: number;
  cancelled: number;
  /** 旅客満足度・航空会社満足度（対象なしは null）と、締め後の空港評価 */
  paxSatisfaction: number | null;
  /** 旅客満足度の内訳（5-04 / D1。満足度がある日だけ）: 各減点と材料の平均値 */
  paxSatisfactionDetail?: { waitPenalty: number; walkPenalty: number; delayPenalty: number; missedPenalty: number; bagsPenalty: number; avgWaitMin: number; avgWalkMin: number; avgDelayMin: number; missedRate: number; leftRate: number };
  airlineSatisfaction: number | null;
  rating: number;
  /** 空港アクセス（Phase 6）: 手段別の旅客数、満車で停められなかった車、道路・車寄せの平均遅れ、乗り場の平均待ち、アクセス係数 */
  modePax?: Partial<Record<AccessMode, number>>;
  parkingFull?: number;
  roadDelayMin?: number;
  transitWaitMin?: number;
  accessFactor?: number;
}

export interface DailyReport {
  day: number;
  partial: boolean;
  revenue: Partial<Record<RevenueCategory, number>>;
  cost: Partial<Record<CostCategory, number>>;
  construction: number;
  totalRevenue: number;
  totalCost: number;
  operatingProfit: number;
  cashEnd: number;
  kpi: DailyKpi;
  /** 目標の報酬の現金（営業収支には入れない。目標を有効にした会社で報酬があった日だけ） */
  grants?: number;
  /** 夜間の運用（city.nightOps）があるときだけ（フェーズ 2、R15）。持ち越し便はその便の予定日に数える */
  night?: { lastDepartureDelayMin: number | null; standHeld: number; originHeld: number; carriedOver: number; diverted: number; cancelled: number };
  /** 朝の始発の波（フェーズ 4 §3.4。滞泊の出発があった日だけ） */
  morningWave?: { departures: number; firstTakeoff: number | null; lastTakeoff: number | null; intervalsSec: number[] };
  /** 整備の記録（フェーズ 4 §3.6。拠点が有効な日だけ） */
  maintenance?: { checked: number; overdue: number; faults: number; techCancelled: number };
  /** 翌朝の出発可能機数（F6-11。翌朝 06:00–10:00 に滞泊便の出発予定がある日だけ）: 予定・確定可能・リスクあり */
  morningReadiness?: { scheduled: number; ready: number; atRisk: number };
  /** 乗継の記録（フェーズ 4 §5.6。ハブが有効な日だけ） */
  hub?: { spawned: number; connected: number; missed: number; noShow: number };
  /** 連絡設備・上下移動設備の利用実績（5-03。利用があったリンクだけ。上下移動の表示名は areaKind から画面側で引く） */
  linkUsage?: { linkId: string; kind: 'transfer' | 'vertical'; label: string; areaKind?: string; total: number; peakHour: number; peakCount: number; capacityPerHour: number | null; hourly: number[] }[];
  /** アクセスの時間帯別交通量の集計（5-03。アクセスの記録がある日だけ） */
  accessUsage?: { mode: string; total: number; peakHour: number; peakCount: number }[];
  /** 資源別の稼働率（5-02。地上支援の車両・人員の種類ごと、当日の busySec から算出） */
  groundUtilization?: { kind: string; units: number; utilization: number }[];
  /** 資源待ちの内訳（5-02。当日の停止理由ごとの累計秒） */
  groundWaits?: { reason: string; sec: number }[];
  /** 乗り遅れの詰まり箇所の内訳（乗り遅れがあった日だけ。人数の多い順。spotId は詰まったエリア/施設） */
  missedBreakdown?: MissBreakdownEntry[];
  /** Portal 通過人数（5-16 T8。通過があった日だけ。方向別の人数で、手段別人数とは二重計上しない） */
  portalUsage?: { portalId: string; facilityId: string; enter: number; exit: number }[];
  /** 工程別の最混雑 60 分（5-21）: 理論能力・計画需要・ピーク時間帯の実績処理・使用率・平均待ち */
  processPeak?: { step: string; capacityPerHour: number; demandPerHour: number; peakHour: number; peakProcessed: number; utilization: number | null; avgWaitSec: number }[];
  /** 5-21 T5: 工程ピークのターミナル別内訳（能力はそのターミナルのエリア合計。需要は空港全体のみ算出するため含めない） */
  processPeakByTerminal?: { terminalId: string; step: string; capacityPerHour: number; peakHour: number; peakProcessed: number; utilization: number | null; avgWaitSec: number }[];
  /** 旅客 Door-to-Door KPI（5-23）: 出現→完了の所要時間の人数重みつき分位点と Step-free 完了率 */
  doorToDoor?: {
    departure: { p50Sec: number; p95Sec: number; pax: number } | null;
    arrival: { p50Sec: number; p95Sec: number; pax: number } | null;
    transfer: { p50Sec: number; p95Sec: number; pax: number } | null;
    stepFree: { completed: number; missed: number; rate: number | null };
  };
  /** 貨物の実績（5-12。貨物契約がある日だけ）: 実際に積み下ろしした量・積み残し・収支。収入と荷役費は台帳（revenue.cargo / cost.cargoHandling）にも計上済み */
  cargo?: { carriedM3: number; leftoverM3: number; revenue: number; handlingCost: number; truckTrips: number };
  city?: { type: CityType; populationStart: number; populationEnd: number; demandCeiling: number; expectedPax: number; actualPax: number; cityFactor: number; roadQuality: number; railQuality: number; residentsStart?: number; residentsEnd?: number; residentDelta?: number; noiseMovements?: number; nightMovements?: number; noisePoints?: number; events?: CityEvent[]; eventDemandMultiplier?: number; eventTrafficMultiplier?: number };
}

/** その日の振り返りを生成するときだけ渡す締め時点の評価スナップショット。会社保存形式には入れない。 */
export interface DailyAirlineAnalysisEntry {
  components: ScoreComponent[];
  satisfactionBefore: number;
  satisfactionAfter: number;
  satisfactionDelta: number;
  emaBefore?: Partial<Record<ScoreKey, number>>;
  emaAfter?: Partial<Record<ScoreKey, number>>;
  complaintsBefore?: ScoreKey[];
  complaintsAfter?: ScoreKey[];
  newComplaints?: ScoreKey[];
  requests?: AirlineRequest[];
  fulfilled?: RequestKind[];
}
export type DailyAirlineAnalysis = Record<string, DailyAirlineAnalysisEntry>;

export interface CompanyState {
  version: 1;
  mode: 'career' | 'sandbox';
  seed: string;
  rng: RngState;
  /** 次に運航する日（0 = 1日目） */
  day: number;
  cash: number;
  counters: Record<string, number>;
  airlines: Record<string, AirlineRelation>;
  contracts: Record<string, Contract>;
  fees: FeeSettings;
  hours: OperatingHours;
  /** 当日の収支（日次締めで日報に移す） */
  today: Partial<Record<LedgerCategory, number>>;
  reports: DailyReport[];
  /** 空港評価（0〜100） */
  rating: number;
  /** 資金がマイナスの連続日数と、経営破綻の判定 */
  negativeDays: number;
  bankrupt: boolean;
  /** 前日の運航で観測したアクセスの混雑（翌日の手段選択・需要に反映） */
  accessFeedback: AccessFeedback;
  /** 日をまたいで駐車している車の出庫時刻（翌日 0:00 からの秒） */
  parkedCars: number[];
  /** 工事（キャリアモード）: エンティティID → 工事の内容と残り日数（economy/expansion.ts） */
  projects: Record<string, Project>;
  /** 航空会社の保有機材と座席構成（機種ID で参照。Phase 7） */
  fleets: Record<string, FleetEntry[]>;
  /** ゲームのモデル（12B-3a）の設定。ない会社は従来のルールのまま（docs/30） */
  game?: GameSettings;
  /** game.airlineEval のときの航空会社の評価（移動平均・不満・要望） */
  airlineEval?: AirlineEvalState;
  /** game.goals のときの目標・空港の格 */
  goals?: GoalState;
  city?: CityConfig;
  /** 路線需要モデル（フェーズ 3）。city がある会社だけ有効 */
  market?: MarketSettings;
  /** フェーズ 4 の機能の有効化（解放は unlocks.ts の判定が別にある） */
  features?: { overnight?: true; based?: true; international?: true; hub?: true; cargo?: true };
  /** 日付をまたぐ機体の記録（フェーズ 4 §3.3） */
  carryOver?: { forDay: number; aircraft: CarryOverAircraft[] };
  /** 拠点契約の所属機 */
  basedFleet?: Record<string, BasedAircraft>;
  /** 整備の枠の端数の繰り越し（施設 ID → 端数） */
  maintenanceCredit?: Record<string, number>;
  /** 拠点の条件を満たさない連続日数（契約 ID → 日数） */
  basedIssueDays?: Record<string, number>;
  /** 乗継・波の設定（フェーズ 4） */
  hub?: HubSettings;
  /** 夜間整備・工事の Work Order（5-25）。欠落 = 機能オフ（旧セーブ互換） */
  workOrders?: Record<string, WorkOrder>;
}

/** Work Order の対象資産 */
export type WorkOrderAssetKind = 'runway' | 'taxiway' | 'stand' | 'gate';
export type WorkOrderKind = 'inspection' | 'repair' | 'construction';
export type WorkOrderStatus = 'planned' | 'active' | 'done' | 'deferred';

/**
 * 夜間整備・工事の作業指示（5-25）。空港資産側の作業だけを扱い、機体の周期整備
 * （Phase 4 の決済時チェック）とは管理を分ける。夜間枠（23:00〜05:00）で整備士が
 * 足りる間だけ進捗し、実施中は対象資産を一時閉鎖する（恒常的な状態変更にしない）。
 */
export interface WorkOrder {
  id: string;
  assetKind: WorkOrderAssetKind;
  assetId: string;
  kind: WorkOrderKind;
  /** 必要な整備士（人） */
  engineers: number;
  /** 所要時間（分） */
  durationMin: number;
  /** 進捗（分） */
  progressMin: number;
  status: WorkOrderStatus;
  createdDay: number;
  /** 滑走路を閉鎖したときの元の運用モード（復旧用。閉鎖していない間は持たない） */
  prevRunwayMode?: string;
}

/** Work Order を採番して会社に追加する */
export function addWorkOrder(c: CompanyState, input: Omit<WorkOrder, 'id' | 'progressMin' | 'status' | 'prevRunwayMode'>): WorkOrder {
  c.workOrders ??= {};
  let n = Object.keys(c.workOrders).length + 1;
  while (c.workOrders[`wo_${n}`]) n++;
  const wo: WorkOrder = { ...input, id: `wo_${n}`, progressMin: 0, status: 'planned' };
  c.workOrders[wo.id] = wo;
  return wo;
}

/** 工事: 新設・改修（移設・拡張）は建設中、一時閉鎖は運用を止めるだけ。残り日数は運航した日で進む */
export interface Project {
  id: string;
  kind: 'build' | 'renovation' | 'closure';
  startDay: number;
  days: number;
  remaining: number;
}

export const REPORT_LIMIT = 120;

export function createCompany(mode: CompanyState['mode'] = 'career', seed = 'company'): CompanyState {
  const airlines: Record<string, AirlineRelation> = {};
  for (const a of AIRLINES) {
    if (!a.legacy) continue;
    if ((a.minimumAirportRating ?? 0) <= 50) airlines[a.id] = { satisfaction: 60, lowDays: 0 };
  }
  return {
    version: 1,
    mode,
    seed,
    rng: new Rng(`company:${seed}`).state(),
    day: 0,
    cash: BALANCE.initialCash[mode],
    counters: {},
    airlines,
    contracts: {},
    fees: { landing: 1, terminal: 1, parking: 1, carPark: 1, taxi: 1, bus: 1, rail: 1 },
    hours: { openMin: 6 * 60, closeMin: 23 * 60, peaks: [{ fromMin: 7 * 60, toMin: 9 * 60 }, { fromMin: 17 * 60, toMin: 19 * 60 }] },
    today: {},
    reports: [],
    rating: 50,
    negativeDays: 0,
    bankrupt: false,
    accessFeedback: { ...NO_FEEDBACK, waitMin: {} },
    parkedCars: [],
    projects: {},
    fleets: defaultFleets(),
  };
}

export function defaultFleets(): Record<string, FleetEntry[]> {
  return Object.fromEntries(
    AIRLINES.filter((a) => a.legacy && (a.minimumAirportRating ?? 0) <= 50).map((a) => [a.id, a.fleet.map((e) => ({ ...e }))]),
  );
}

/** 提案・更新の1日あたり便数の上限。market 有効時は相手空港の混雑で減る（フェーズ 3 §3.4） */
export function maxPerDayFor(c: CompanyState, dest?: DestinationDef): number {
  const base = (c.rating >= 70 ? 4 : c.rating >= 50 ? 3 : 2) + tierBonus(c);
  if (!c.market || !dest) return base;
  return Math.max(1, Math.round(base * (1 - 0.5 * dest.congestion)));
}

/** 便の座席数: 航空会社の座席構成にあればその値、なければ機種の既定値 */
export function seatsFor(c: CompanyState, airlineId: string, typeId: AircraftTypeId, types: TypeTable = AIRCRAFT_TYPES): number {
  return c.fleets?.[airlineId]?.find((e) => e.typeId === typeId)?.seats ?? resolveType(types, typeId).seats;
}

export type FleetResult = { ok: true } | { ok: false; reason: 'UNKNOWN_TYPE' | 'SEATS_INVALID' | 'OVER_MAX_PAX' | 'NOT_IN_FLEET' | 'IN_USE' | 'NOT_FOUND' };

/**
 * 座席数の上限: 最大旅客定員（公式値）があればそれ、なければゲーム上の上限（既定座席数 × 1.25）。
 * 実機の認定定員が確認できない機種は上限を推定値で扱う（docs/16 §3）。
 */
export function maxSeatsOf(typeId: AircraftTypeId, types: TypeTable = AIRCRAFT_TYPES): { max: number; official: boolean } {
  const t = resolveType(types, typeId);
  return t.maxPax !== null ? { max: t.maxPax, official: true } : { max: Math.round(t.seats * 1.25), official: false };
}

/** 保有機材の追加・座席数の変更 */
export function setFleetEntry(c: CompanyState, airlineId: string, typeId: AircraftTypeId, seats: number, types: TypeTable = AIRCRAFT_TYPES): FleetResult {
  if (!c.airlines[airlineId]) return { ok: false, reason: 'NOT_FOUND' };
  if (!types[typeId]) return { ok: false, reason: 'UNKNOWN_TYPE' };
  if (!Number.isInteger(seats) || seats < 1) return { ok: false, reason: 'SEATS_INVALID' };
  if (seats > maxSeatsOf(typeId, types).max) return { ok: false, reason: 'OVER_MAX_PAX' };
  const fleet = (c.fleets[airlineId] ??= []);
  const e = fleet.find((x) => x.typeId === typeId);
  if (e) e.seats = seats;
  else fleet.push({ typeId, seats });
  return { ok: true };
}

/** 保有機材から外す（契約で使っている機種は外せない） */
export function removeFleetEntry(c: CompanyState, airlineId: string, typeId: AircraftTypeId): FleetResult {
  const fleet = c.fleets[airlineId];
  if (!fleet?.some((e) => e.typeId === typeId)) return { ok: false, reason: 'NOT_FOUND' };
  if (contractsOf(c).some((k) => k.airlineId === airlineId && k.typeId === typeId && (k.status === 'active' || k.status === 'offered'))) {
    return { ok: false, reason: 'IN_USE' };
  }
  c.fleets[airlineId] = fleet.filter((e) => e.typeId !== typeId);
  return { ok: true };
}

/**
 * 契約の機材変更（便への機材割り当て）: 航空会社の保有機材の機種に変える。
 * 機種を変えると旅客定員・地上作業・施設の適合性・着陸料が変わる（翌日の運航計画から）。
 */
export function changeContractAircraft(c: CompanyState, contractId: string, typeId: AircraftTypeId): FleetResult {
  const k = c.contracts[contractId];
  if (!k) return { ok: false, reason: 'NOT_FOUND' };
  if (!(c.fleets[k.airlineId] ?? airlineDef(k.airlineId).fleet).some((e) => e.typeId === typeId)) return { ok: false, reason: 'NOT_IN_FLEET' };
  k.typeId = typeId;
  return { ok: true };
}

function nextId(c: CompanyState, prefix: string): string {
  const n = (c.counters[prefix] ?? 0) + 1;
  c.counters[prefix] = n;
  return `${prefix}_${n}`;
}

/** 収支を記録する（現金残高も更新） */
export function post(c: CompanyState, category: LedgerCategory, amount: number): void {
  if (!Number.isFinite(amount) || amount === 0) return;
  const v = Math.round(amount);
  c.today[category] = (c.today[category] ?? 0) + v;
  c.cash += v;
}

export const isRevenue = (k: LedgerCategory): k is RevenueCategory => (REVENUE_CATEGORIES as readonly string[]).includes(k);

export function contractsOf(c: CompanyState, status?: Contract['status']): Contract[] {
  return Object.values(c.contracts)
    .filter((k) => !status || k.status === status)
    .sort((a, b) => compareIds(a.id, b.id));
}

/** その日に運航する契約 */
export function activeContractsOn(c: CompanyState, day: number): Contract[] {
  return contractsOf(c, 'active').filter((k) => k.startDay <= day && day <= k.endDay);
}

export function addContract(c: CompanyState, k: Omit<Contract, 'id' | 'numberBase'>): Contract {
  const id = nextId(c, 'ct');
  const n = Number(id.slice(3));
  const contract: Contract = { ...k, id, numberBase: 100 + n * 20 };
  c.contracts[id] = contract;
  return contract;
}

// ---------------------------------------------------------------- プレイヤーの操作

export type ContractActionResult = { ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_OFFERED' | 'NOT_ACTIVE' | 'UNSUPPORTED' | 'AIRLINE_ROUTE_UNSUPPORTED' | 'INTERNATIONAL_PROCESSING_REQUIRED' | 'CAPACITY_INSUFFICIENT' | 'AIRLINE_REFUSED' | 'MIN_FREQUENCY' | 'LOCKED' | 'NO_CHANGE' | 'COUNTER_TOO_SOON' };

/** 提案を受け入れる（翌運航日から有効）。supported = 空港で運航可能な機種か */
export function acceptOffer(
  c: CompanyState,
  id: string,
  supported: boolean,
  routeStatus: 'available' | 'airline-unsupported' | 'international-processing-required' = 'available',
  capacityStatus: 'acceptable' | 'conditional' | 'unacceptable' = 'acceptable',
): ContractActionResult {
  const k = c.contracts[id];
  if (!k) return { ok: false, reason: 'NOT_FOUND' };
  if (k.status !== 'offered') return { ok: false, reason: 'NOT_OFFERED' };
  // フェーズ 4: 解放・有効化されていない種類の契約は受け入れない
  const kindFeature = featureForContractKind(k.kind);
  if (kindFeature && !featureOn(c, kindFeature)) return { ok: false, reason: 'LOCKED' };
  if (!supported) return { ok: false, reason: 'UNSUPPORTED' };
  if (routeStatus === 'airline-unsupported') return { ok: false, reason: 'AIRLINE_ROUTE_UNSUPPORTED' };
  if (routeStatus === 'international-processing-required') return { ok: false, reason: 'INTERNATIONAL_PROCESSING_REQUIRED' };
  if (capacityStatus === 'unacceptable') return { ok: false, reason: 'CAPACITY_INSUFFICIENT' };

  // 新規契約の受諾時に、過去の撤退カウントをリセットする
  c.airlines[k.airlineId]!.lowDays = 0;

  k.status = 'active';
  k.startDay = c.day;
  // 拠点契約の期間は通常の 3 倍（フェーズ 4 §3.5）
  k.endDay = c.day + BALANCE.offers.contractDays * (k.kind === 'based' ? 3 : 1) - 1;
  // 拠点契約: 所属機を登録する
  if (k.kind === 'based') {
    c.basedFleet ??= {};
    const n = k.basedAircraft ?? 1;
    for (let i = 0; i < n; i++) {
      const id = `ba_${Object.keys(c.basedFleet).length + 1}`;
      c.basedFleet[id] = { id, airlineId: k.airlineId, contractId: k.id, typeId: k.typeId, cycles: 0, lastCheckDay: null };
    }
  }
  return { ok: true };
}

export function rejectOffer(c: CompanyState, id: string): ContractActionResult {
  const k = c.contracts[id];
  if (!k) return { ok: false, reason: 'NOT_FOUND' };
  if (k.status !== 'offered') return { ok: false, reason: 'NOT_OFFERED' };
  k.status = 'rejected';
  return { ok: true };
}

/**
 * 便数の変更を依頼する。増便は航空会社の満足度が一定以上のときだけ応じる。減便は満足度が下がる。
 */
export function changeFrequency(
  c: CompanyState,
  id: string,
  delta: 1 | -1,
  capacityStatus: 'acceptable' | 'conditional' | 'unacceptable' = 'acceptable',
): ContractActionResult {
  const k = c.contracts[id];
  if (!k) return { ok: false, reason: 'NOT_FOUND' };
  if (k.status !== 'active') return { ok: false, reason: 'NOT_ACTIVE' };
  const rel = c.airlines[k.airlineId]!;
  if (delta > 0) {
    if (rel.satisfaction < BALANCE.contracts.increaseMinSat - increaseMinSatRelief(c, k.airlineId)) return { ok: false, reason: 'AIRLINE_REFUSED' };
    if (capacityStatus === 'unacceptable') return { ok: false, reason: 'CAPACITY_INSUFFICIENT' };
    k.perDay += 1;
  } else {
    if (k.perDay <= 1) return { ok: false, reason: 'MIN_FREQUENCY' };
    k.perDay -= 1;
    rel.satisfaction = Math.max(0, rel.satisfaction - BALANCE.contracts.decreasePenaltySat);
  }
  return { ok: true };
}

/**
 * 契約の逆提案（5-08 / B2）: 提案中の契約に、時間帯・便数・割引の変更を航空会社へ申し入れる。
 * 受諾の判定は決定的: 満足度を基礎に、割引を増やす申し入れは通りやすく、便数を増やす申し入れは通りにくい。
 * 受け入れられれば提案の条件が変わる（契約するかどうかは別途）。断られると満足度が少し下がり、その日は再提案できない。
 */
export function counterOffer(
  c: CompanyState,
  id: string,
  changes: { window?: Contract['window']; perDay?: number; feeDiscount?: number },
): ContractActionResult {
  const k = c.contracts[id];
  if (!k) return { ok: false, reason: 'NOT_FOUND' };
  if (k.status !== 'offered') return { ok: false, reason: 'NOT_OFFERED' };
  if (k.counterRefusedDay === c.day) return { ok: false, reason: 'COUNTER_TOO_SOON' };
  const next = {
    window: changes.window ?? k.window,
    perDay: changes.perDay !== undefined ? Math.min(12, Math.max(1, Math.round(changes.perDay))) : k.perDay,
    feeDiscount: changes.feeDiscount !== undefined ? Math.min(0.4, Math.max(0, changes.feeDiscount)) : k.feeDiscount,
  };
  if (next.window === k.window && next.perDay === k.perDay && next.feeDiscount === k.feeDiscount) return { ok: false, reason: 'NO_CHANGE' };
  const rel = c.airlines[k.airlineId]!;
  const score = rel.satisfaction
    + (next.feeDiscount - k.feeDiscount) * 200
    - Math.max(0, next.perDay - k.perDay) * 5
    - (next.window !== k.window ? 5 : 0);
  if (score < 55) {
    rel.satisfaction = Math.max(0, rel.satisfaction - 3);
    k.counterRefusedDay = c.day;
    return { ok: false, reason: 'AIRLINE_REFUSED' };
  }
  k.window = next.window;
  k.perDay = next.perDay;
  k.feeDiscount = next.feeDiscount;
  return { ok: true };
}

/** 専用スポットの設定・解除（5-08）。契約が有効な間だけ意味を持つ */
export function setDedicatedStand(c: CompanyState, id: string, standId: string | null): ContractActionResult {
  const k = c.contracts[id];
  if (!k) return { ok: false, reason: 'NOT_FOUND' };
  if (standId) k.dedicatedStandId = standId;
  else delete k.dedicatedStandId;
  return { ok: true };
}

export function setFees(c: CompanyState, fees: Partial<FeeSettings>): void {
  for (const [k, v] of Object.entries(fees) as [keyof FeeSettings, number][]) {
    if (Number.isFinite(v)) c.fees[k] = Math.min(2, Math.max(0.5, Math.round(v * 20) / 20));
  }
}

export function setHours(c: CompanyState, hours: Partial<OperatingHours>): void {
  if (hours.openMin !== undefined && hours.closeMin !== undefined && hours.closeMin - hours.openMin < 6 * 60) return;
  c.hours = { ...c.hours, ...hours };
}

// ---------------------------------------------------------------- 日次の更新（提案・契約・評価）

function withRng<T>(c: CompanyState, fn: (rng: Rng) => T): T {
  const rng = new Rng(c.rng);
  const v = fn(rng);
  c.rng = rng.state();
  return v;
}

/**
 * 新しい契約提案を作る。航空会社ごとに、空港評価が高いほど提案しやすい。
 * operableTypes = 現在の空港で運航できる機種（それ以外の機種の提案も「受け入れ不可」として届く）
 */
export function generateOffers(
  c: CompanyState,
  operable: readonly AircraftTypeId[],
  originCountryId = HOME_COUNTRY_ID,
  internationalPassengerProcessing = false,
): Contract[] {
  const out: Contract[] = [];
  const open = () => contractsOf(c, 'offered').length;
  withRng(c, (rng) => {
    for (const a of airlinesFor(c)) {
      if (open() >= BALANCE.offers.maxOpen) break;
      if (c.rating < (a.minimumAirportRating ?? 0)) continue;
      // 格による解放（フェーズ 4 §2.3）: 目標がある会社では unlock.minTier を格と比べる（legacy 項目は minTier を持たないので従来の提案は変わらない）
      if (c.game?.goals && c.goals && a.unlock.minTier !== undefined && c.goals.tier < a.unlock.minTier) continue;
      const rel = (c.airlines[a.id] ??= { satisfaction: 60, lowDays: 0 });
      c.fleets[a.id] ??= a.fleet.map((entry) => ({ ...entry }));
      const p = (BALANCE.offers.baseProb + BALANCE.offers.ratingProb * (c.rating / 100) * (rel.satisfaction / 60)) * offerBoost(c, a.id);
      if (rng.next() >= p) continue;
      const served = new Set(contractsOf(c).filter((k) => k.airlineId === a.id && (k.status === 'active' || k.status === 'offered')).map((k) => k.destinationId));
      const dests = destinationsFor(c).filter((d) => {
        if (served.has(d.id) || c.rating < (d.minimumAirportRating ?? 0)) return false;
        if (c.game?.goals && c.goals && d.unlock.minTier !== undefined && c.goals.tier < d.unlock.minTier) return false;
        return routeAvailability(a, d, { originCountryId, internationalPassengerProcessing }) === 'available';
      });
      if (dests.length === 0) continue;
      // market 有効時（フェーズ 3 §4.3）: 行き先は未充足需要 w = max(0.05, D_r − S_r) の重みで選ぶ（乱数は 1 回だけ使う）
      let dest: DestinationDef;
      let unmet = 0;
      if (c.market && c.city) {
        const weights = dests.map((d) => {
          const demand = routeDemand(c, d, 1) ?? 0;
          const supplied = contractsOf(c)
            .filter((k) => k.destinationId === d.id && (k.status === 'active' || k.status === 'offered'))
            .reduce((s, k) => s + k.perDay * seatsFor(c, k.airlineId, k.typeId) * 2, 0);
          return Math.max(0.05, demand - supplied);
        });
        const totalW = weights.reduce((s, w) => s + w, 0);
        let x = rng.next() * totalW;
        let idx = 0;
        while (idx < dests.length - 1 && x >= weights[idx]!) {
          x -= weights[idx]!;
          idx++;
        }
        dest = dests[idx]!;
        unmet = weights[idx]!;
      } else {
        dest = dests[rng.int(0, dests.length - 1)]!;
      }
      // 運航できる機種を優先しつつ、評価が高いと大型機の提案も来る
      const own = (c.fleets[a.id] ?? a.fleet).map((e) => e.typeId);
      if (own.length === 0) continue;
      const fleet = own.filter((t) => operable.includes(t) || (resolveType(AIRCRAFT_TYPES, t).size === 'L' && c.rating >= 60 && !aircraftIsLow(c, a.id)) || rng.next() < 0.25);
      const candidates = fleet.length > 0 ? fleet : own;
      let typeId = candidates[rng.int(0, candidates.length - 1)]!;
      const maxPerDay = maxPerDayFor(c, dest);
      const windows: TimeWindow[] = ['morning', 'daytime', 'evening', 'any'];
      // 乱数の消費順は従来と同一に保つ（discount の rng.next() → perDay の rng.int() → window の rng.int()）
      const discount =
        a.type === 'lcc' ? 0.2 + rng.next() * 0.2 : a.type === 'regional' ? 0.1 + rng.next() * 0.15 : rng.next() * 0.15;
      let perDay = rng.int(1, maxPerDay);
      if (c.market && c.city) {
        // 機種と便数は、未充足需要に最も近い座席供給（座席 × 便数 × 2）の組を選ぶ（追加の乱数は使わない）
        let best = Number.POSITIVE_INFINITY;
        for (const t of candidates) {
          const seats = seatsFor(c, a.id, t);
          for (let pd = 1; pd <= maxPerDay; pd++) {
            const diff = Math.abs(seats * pd * 2 - unmet);
            if (diff < best) {
              best = diff;
              typeId = t;
              perDay = pd;
            }
          }
        }
      }
      out.push(
        addContract(c, {
          airlineId: a.id,
          destinationId: dest.id,
          typeId,
          perDay,
          window: windows[rng.int(0, windows.length - 1)]!,
          feeDiscount: Math.round(discount * 100) / 100,
          startDay: c.day,
          endDay: c.day + BALANCE.offers.contractDays - 1,
          status: 'offered',
          offerExpiresDay: c.day + BALANCE.offers.expireDays,
        }),
      );
    }
  });
  out.push(...generatePhase4Offers(c, operable, originCountryId, internationalPassengerProcessing));
  out.push(...generateCargoOffers(c, operable, originCountryId, internationalPassengerProcessing));
  return out;
}

/**
 * フェーズ 4 の新しい種類の提案（夜間滞泊・拠点）。専用の種で作り、従来の提案の乱数を消費しない。
 * 解放・有効化されている機能だけが対象。候補は airlinesFor / destinationsFor で作る。
 */
export function generatePhase4Offers(
  c: CompanyState,
  operable: readonly AircraftTypeId[],
  originCountryId = HOME_COUNTRY_ID,
  internationalPassengerProcessing = false,
): Contract[] {
  const out: Contract[] = [];
  const wantOvernight = featureOn(c, 'overnight');
  const wantBased = featureOn(c, 'based');
  if (!wantOvernight && !wantBased) return out;
  const rng = new Rng(`${c.seed}:offers4:${c.day}`);
  // 新しい種類の提案は従来の枠（maxOpen）とは別に最大 2 件まで（従来の提案を押し出さない）
  const open = () => contractsOf(c, 'offered').filter((k) => k.kind !== undefined).length + out.length;
  for (const a of airlinesFor(c)) {
    if (open() >= 2) break;
    if (c.rating < (a.minimumAirportRating ?? 0)) continue;
    if (c.game?.goals && c.goals && a.unlock.minTier !== undefined && c.goals.tier < a.unlock.minTier) continue;
    const served = new Set(contractsOf(c).filter((k) => k.airlineId === a.id && (k.status === 'active' || k.status === 'offered')).map((k) => `${k.destinationId}:${k.kind ?? 'turnaround'}`));
    const dests = destinationsFor(c).filter((d) => {
      if (c.rating < (d.minimumAirportRating ?? 0)) return false;
      if (c.game?.goals && c.goals && d.unlock.minTier !== undefined && c.goals.tier < d.unlock.minTier) return false;
      return routeAvailability(a, d, { originCountryId, internationalPassengerProcessing }) === 'available';
    });
    const own = (c.fleets[a.id] ?? a.fleet).map((e) => e.typeId).filter((t) => operable.includes(t));
    if (own.length === 0) continue;
    if (wantOvernight && rng.next() < 0.35) {
      const candidates = dests.filter((d) => !served.has(`${d.id}:overnight`) && d.scope === 'domestic');
      if (candidates.length > 0) {
        const dest = candidates[rng.int(0, candidates.length - 1)]!;
        out.push(addContract(c, {
          airlineId: a.id, destinationId: dest.id, typeId: own[rng.int(0, own.length - 1)]!,
          perDay: rng.int(1, 3), window: 'evening', feeDiscount: 0.1,
          startDay: c.day, endDay: c.day + BALANCE.offers.contractDays - 1, status: 'offered',
          offerExpiresDay: c.day + BALANCE.offers.expireDays, kind: 'overnight',
        }));
        continue;
      }
    }
    if (wantBased && a.canBase && rng.next() < 0.3) {
      const candidates = dests.filter((d) => !served.has(`${d.id}:based`) && d.scope === 'domestic');
      if (candidates.length > 0) {
        const dest = candidates[rng.int(0, candidates.length - 1)]!;
        out.push(addContract(c, {
          airlineId: a.id, destinationId: dest.id, typeId: own[rng.int(0, own.length - 1)]!,
          perDay: rng.int(1, 3), window: 'any', feeDiscount: 0.25,
          startDay: c.day, endDay: c.day + BALANCE.offers.contractDays * 3 - 1, status: 'offered',
          offerExpiresDay: c.day + BALANCE.offers.expireDays, kind: 'based', basedAircraft: rng.int(2, 4),
        }));
      }
    }
  }
  return out;
}

/**
 * 貨物契約の提案（5-12 CARGO-02）。専用の種で作り、従来の提案の乱数を消費しない。
 * 貨物機能が解放・有効化され、貨物サービスを持つ航空会社だけが対象。
 * 機種はその会社の保有機（旅客フリート＋貨物専用機）のうち貨物室容積が判明している最大のものを選ぶ（推定はしない）。
 */
export function generateCargoOffers(
  c: CompanyState,
  operable: readonly AircraftTypeId[],
  originCountryId = HOME_COUNTRY_ID,
  internationalPassengerProcessing = false,
): Contract[] {
  const out: Contract[] = [];
  if (!featureOn(c, 'cargo') || !c.city) return out;
  const rng = new Rng(`${c.seed}:offersCargo:${c.day}`);
  // addContract は生成と同時に c.contracts へ status 'offered' で登録するので、contractsOf だけで
  // 生成直後の分も数えられる（out.length を足すと二重に数えて上限 2 件が実質 1 件になっていた）
  const open = () => contractsOf(c, 'offered').filter((k) => k.kind === 'cargo').length;
  for (const a of airlinesFor(c)) {
    if (open() >= 2) break;
    if (!airlineCargoEligible(a.id)) continue;
    if (c.rating < (a.minimumAirportRating ?? 0)) continue;
    if (c.game?.goals && c.goals && a.unlock.minTier !== undefined && c.goals.tier < a.unlock.minTier) continue;
    const served = new Set(contractsOf(c).filter((k) => k.airlineId === a.id && k.kind === 'cargo' && (k.status === 'active' || k.status === 'offered')).map((k) => k.destinationId));
    // 候補は旅客フリートのうち容積が判明している機種と、貨物専用機（cargoFleet。旅客フリートには入れない）
    // 大型貨物専用機（B777F / B747F 系）を使う契約は格 5「取扱規模拡張」で解放する（CARGO-08、PO 承認 2026-11-19）。
    // 判定は提案生成だけに掛け、既に締結済みの契約は格が下がっても運航を続ける（既得権）。
    const allowLargeFreighter = effectiveTier(c) >= 5;
    const own = [...new Set([...(c.fleets[a.id] ?? a.fleet).map((e) => e.typeId), ...(a.cargoFleet ?? [])])].filter((t) => operable.includes(t) && cargoHoldM3(t) !== null && (allowLargeFreighter || !isLargeFreighter(t)));
    if (own.length === 0) continue;
    const typeId = own.reduce((best, t) => ((cargoHoldM3(t) ?? 0) > (cargoHoldM3(best) ?? 0) ? t : best), own[0]!);
    const dests = destinationsFor(c).filter((d) => {
      if (served.has(d.id)) return false;
      if (c.rating < (d.minimumAirportRating ?? 0)) return false;
      if (c.game?.goals && c.goals && d.unlock.minTier !== undefined && c.goals.tier < d.unlock.minTier) return false;
      if (routeAvailability(a, d, { originCountryId, internationalPassengerProcessing }) !== 'available') return false;
      // 国際貨物は格 4（国際空港）が必要（CARGO-08）。国内貨物は貨物解放の格 3 で足りる
      if (d.countryId !== originCountryId && effectiveTier(c) < 4) return false;
      return (routeCargoDemandM3(c, d) ?? 0) >= BALANCE.cargo.minRouteDemandM3;
    });
    if (dests.length === 0) continue;
    const dest = dests[rng.int(0, dests.length - 1)]!;
    out.push(addContract(c, {
      airlineId: a.id, destinationId: dest.id, typeId,
      perDay: rng.int(1, 2), window: 'any', feeDiscount: 0.1,
      startDay: c.day, endDay: c.day + BALANCE.offers.contractDays - 1, status: 'offered',
      offerExpiresDay: c.day + BALANCE.offers.expireDays, kind: 'cargo',
    }));
  }
  return out;
}

/** 航空会社ごとの当日の実績（満足度の更新に使う） */
export interface AirlineDayResult {
  flights: number;
  onTime: number;
  paxBoarded: number;
  missedPax: number;
  leftBags: number;
  cancelled: number;
  /** 天候による欠航の数（cancelled の内数。天候 5 段階の運航だけ設定する。欠航の満足度ペナルティは半分） */
  weatherCancelled?: number;
  /** プレイヤーの先行欠航の数（cancelled の内数。満足度のペナルティは 1 便あたり 0.5 = 折り返し 1 回で 1） */
  earlyCancelled?: number;
}

/** 欠航の満足度ペナルティ: 1 便あたり 5。天候による欠航は 1/4（折り返し 1 回 = 2 便で 2.5）、先行欠航は 1/10（折り返し 1 回で 1） */
function cancelPenalty(r: AirlineDayResult): number {
  const wc = r.weatherCancelled ?? 0;
  const ec = r.earlyCancelled ?? 0;
  return (r.cancelled - wc - ec + wc * 0.25 + ec * 0.1) * 5;
}

/**
 * 日次の契約更新: 航空会社の満足度、撤退、契約満了と更新、提案の期限切れ。
 * 満足度の変化 = 定時率が要求以上なら +2、未満なら −(要求 − 定時率)×40
 *              − (料金倍率 − 1) × 料金への敏感さ × 12 − 乗り遅れ率 × 100 − 積み残し率 × 50 − 欠航 × 5
 */
export function updateContracts(c: CompanyState, results: Record<string, AirlineDayResult>, ev?: { deltas: Record<string, number>; bonus: Record<string, number> }, operable?: readonly AircraftTypeId[]): string[] {
  const events: string[] = [];
  const feeRatio = (c.fees.landing + c.fees.terminal + c.fees.parking) / 3;
  for (const a of airlinesFor(c)) {
    const r = results[a.id];
    const hasContract = contractsOf(c, 'active').some((k) => k.airlineId === a.id);
    if (!hasContract && !r && !c.airlines[a.id]) continue;
    const rel = (c.airlines[a.id] ??= { satisfaction: 60, lowDays: 0 });
    let delta = 0;
    if (ev) {
      // 評価要素から計算した変化（定時率・乗り遅れ・料金は要素に含まれる）。欠航のペナルティだけ従来どおり別に引く
      delta = (ev.deltas[a.id] ?? 0) + (ev.bonus[a.id] ?? 0);
      // 全便が欠航した日は flights が 0（欠航は flights に数えない）。欠航があれば引く（1-21 S-3）
      if (r && (r.flights > 0 || r.cancelled > 0)) delta -= cancelPenalty(r);
    } else if (r && r.flights > 0) {
      const otp = r.onTime / r.flights;
      const minOtp = a.minOtp + otpAddOf(c);
      delta += otp >= minOtp ? 2 : -(minOtp - otp) * 40;
      if (r.paxBoarded + r.missedPax > 0) delta -= (r.missedPax / (r.paxBoarded + r.missedPax)) * 100;
      if (r.paxBoarded > 0) delta -= Math.min(20, (r.leftBags / Math.max(1, r.paxBoarded)) * 50);
      delta -= cancelPenalty(r);
    }
    if (!ev) delta -= (feeRatio - 1) * a.priceSensitivity * BALANCE.feeSensitivity.satisfactionPerRatio;
    rel.satisfaction = Math.max(0, Math.min(100, rel.satisfaction + delta));
    rel.lowDays = rel.satisfaction < BALANCE.contracts.withdrawSat ? rel.lowDays + 1 : 0;
  }
  for (const k of contractsOf(c)) {
    const rel = c.airlines[k.airlineId]!;
    if (k.status === 'offered' && c.day >= k.offerExpiresDay) k.status = 'expired';
    if (k.status !== 'active') continue;
    if (rel.lowDays >= BALANCE.contracts.withdrawDays) {
      k.status = 'withdrawn';
      events.push(`${airlineDef(k.airlineId).name} が撤退しました（満足度の低下）`);
    } else if (c.day >= k.endDay) {
      // market 有効時（フェーズ 3 §4.2）: 増便は需要の要望（signal）があるときだけ。増便が上限なら代わりに大型化する
      const marketState = c.market?.routes[k.id];
      const growOk = !c.market || marketState?.signal === 'grow';
      if (rel.satisfaction >= BALANCE.contracts.renewGoodSat && complaintCount(c, k.airlineId) < COMPLAINTS_BLOCK_INCREASE && growOk) {
        k.endDay = c.day + BALANCE.offers.contractDays;
        let acted = false;
        if (c.market && k.perDay >= maxPerDayFor(c, destinationDef(k.destinationId))) {
          const curSeats = seatsFor(c, k.airlineId, k.typeId);
          const bigger = (c.fleets[k.airlineId] ?? airlineDef(k.airlineId).fleet)
            .filter((e) => e.typeId !== k.typeId && seatsFor(c, k.airlineId, e.typeId) > curSeats && (!operable || operable.includes(e.typeId)))
            .sort((x, y) => seatsFor(c, k.airlineId, x.typeId) - seatsFor(c, k.airlineId, y.typeId))[0];
          if (bigger && changeContractAircraft(c, k.id, bigger.typeId).ok) {
            events.push(`${airlineDef(k.airlineId).name} が契約を大型化して更新しました`);
            acted = true;
          }
        }
        if (!acted) {
          if (c.market && k.perDay >= maxPerDayFor(c, destinationDef(k.destinationId))) {
            events.push(`${airlineDef(k.airlineId).name} が契約を更新しました`);
          } else {
            k.perDay += 1;
            events.push(`${airlineDef(k.airlineId).name} が契約を増便して更新しました`);
          }
        }
        if (marketState) delete marketState.signal;
      } else if (rel.satisfaction >= BALANCE.contracts.renewOkSat) {
        k.endDay = c.day + BALANCE.offers.contractDays;
        events.push(`${airlineDef(k.airlineId).name} が契約を更新しました`);
      } else {
        k.status = 'ended';
        events.push(`${airlineDef(k.airlineId).name} の契約が満了し、更新されませんでした`);
      }
    }
  }
  return events;
}

/**
 * キャリアモードの開始状態: 小さな飛行場向けの初期契約（汎用リージョナル機2便・Boeing 737-800 1便）つき。
 */
export function createCareerCompany(seed = 'career'): CompanyState {
  const c = createCompany('career', seed);
  const base = { feeDiscount: 0.1, startDay: 0, endDay: BALANCE.offers.contractDays - 1, status: 'active' as const, offerExpiresDay: 0 };
  addContract(c, { ...base, airlineId: 'RJ', destinationId: 'KTA', typeId: 'regional70', perDay: 2, window: 'any' });
  addContract(c, { ...base, airlineId: 'HB', destinationId: 'MSK', typeId: 'B737-800', perDay: 1, window: 'daytime' });
  return c;
}

/**
 * サンドボックスモードの開始状態: 資金はほぼ無制限で、サンプル空港の規模に合わせた契約つき。
 */
export function createSandboxCompany(seed = 'sandbox'): CompanyState {
  const c = createCompany('sandbox', seed);
  const base = { feeDiscount: 0.1, startDay: 0, endDay: 9999, status: 'active' as const, offerExpiresDay: 0 };
  const list: [string, string, AircraftTypeId, number, TimeWindow][] = [
    ['NP', 'TWN', 'A320neo', 3, 'any'],
    ['NP', 'HSM', 'B777-300', 1, 'daytime'],
    ['NP', 'YKH', 'A320neo', 3, 'any'],
    ['NP', 'AOS', 'A350-900', 1, 'evening'],
    ['RJ', 'KTA', 'regional70', 4, 'any'],
    ['AQ', 'MSK', 'A320-200', 4, 'any'],
    ['HB', 'NSH', 'regional70', 3, 'any'],
  ];
  for (const [airlineId, destinationId, typeId, perDay, window] of list) addContract(c, { ...base, airlineId, destinationId, typeId, perDay, window });
  return c;
}

/** 保存データの読み込み（形式が合わなければ null） */
export function importCompany(json: string): CompanyState | null {
  try {
    const c = JSON.parse(json) as CompanyState;
    if (c?.version !== 1 || typeof c.cash !== 'number' || typeof c.contracts !== 'object') return null;
    // ID の別名対応（フェーズ 3 §2.1。ID_ALIASES が空なら何もしない＝現行データは不変）
    const remap = <T,>(rec: Record<string, T> | undefined, resolve: (id: string) => string): Record<string, T> | undefined => {
      if (!rec) return rec;
      const out: Record<string, T> = {};
      for (const [k, v] of Object.entries(rec)) out[resolve(k)] = v;
      return out;
    };
    c.airlines = remap(c.airlines, resolveAirlineId) ?? {};
    const fleets = remap(c.fleets, resolveAirlineId);
    if (fleets) c.fleets = fleets;
    if (c.airlineEval) c.airlineEval = remap(c.airlineEval, resolveAirlineId);
    for (const k of Object.values(c.contracts)) {
      if (typeof k.airlineId === 'string') k.airlineId = resolveAirlineId(k.airlineId);
      if (typeof k.destinationId === 'string') k.destinationId = resolveDestinationId(k.destinationId);
    }
    // Phase 5 の保存データ: アクセス関連の項目を補う
    c.fees = Object.assign({ carPark: 1, taxi: 1, bus: 1, rail: 1 }, c.fees);
    // 格の尺度の移行（5-20 §3.7）: 旧 4 段階尺度のセーブを一度だけ新 8 段階尺度へ移す。
    // tierScale が付いたデータには二度と適用しない。旧 3 → 新 5 で国際・ハブの解放を保つ。
    if (c.goals && c.goals.tierScale !== 2) {
      const mapped = LEGACY_TIER_MAP[c.goals.tier];
      if (mapped !== undefined) c.goals.tier = mapped;
      c.goals.tierScale = 2;
    }
    c.accessFeedback ??= { ...NO_FEEDBACK, waitMin: {} };
    c.parkedCars ??= [];
    c.projects ??= {};
    // 12B-3a: ゲームの設定の形が不正なら捨てて従来のルールに戻す（読み込みは止めない。厳格な検証は validateProject）
    if (c.game !== undefined && checkGameSettings(c.game) !== null) delete c.game;
    if (c.airlineEval !== undefined && checkAirlineEval(c.airlineEval).length > 0) delete c.airlineEval;
    if (c.goals !== undefined && checkGoals(c.goals).length > 0) delete c.goals;
    if (c.city !== undefined && !isCityConfig(c.city)) delete c.city;
    // market の形が不正なら捨てる。city がない会社の market も捨てる（フェーズ 3 §2.2 の寛容読み込み）
    if (c.market !== undefined && checkMarket(c.market).length > 0) delete c.market;
    if (c.market && !c.city) delete c.market;
    // features がない会社のフェーズ 4 の状態は捨てる（フェーズ 4 §1 の寛容読み込み）
    if (!c.features) {
      delete c.carryOver;
      delete c.basedFleet;
      delete c.hub;
    }
    // 対応するゲーム設定のフラグがない評価・目標のデータは捨てる（フラグとデータの食い違いを持ち込まない）
    if (!c.game?.airlineEval) delete c.airlineEval;
    if (!c.game?.goals) delete c.goals;
    // Phase 6 以前の保存データ: 保有機材の設定がないので初期設定を入れ、契約で使っている機種（旧形式の汎用機材を含む）は
    // そのまま保有機材に加える（汎用機材を実在の機種に置き換えない）
    if (!c.fleets) {
      c.fleets = defaultFleets();
      for (const k of Object.values(c.contracts)) {
        const f = (c.fleets[k.airlineId] ??= []);
        if (!f.some((e) => e.typeId === k.typeId)) f.push({ typeId: k.typeId, seats: resolveType(AIRCRAFT_TYPES, k.typeId).seats });
      }
    }
    return c;
  } catch {
    return null;
  }
}
