import { Rng, type RngState } from '../rng';
import { compareIds } from '../model/ids';
import { AIRCRAFT_TYPES, resolveType, type AircraftTypeId, type TypeTable } from '../sim/aircraftTypes';
import { BALANCE } from './balance';
import { AIRLINES, DESTINATIONS, airlineDef, type FleetEntry } from './registry';
import { NO_FEEDBACK, type AccessFeedback, type AccessMode } from '../access/model';
import { checkGameSettings, otpAddOf, type GameSettings } from './game';
import { checkAirlineEval, type AirlineEvalState } from './airlineEval';
import { aircraftIsLow, complaintCount, COMPLAINTS_BLOCK_INCREASE, increaseMinSatRelief, offerBoost, tierBonus } from './evalRules';
import { checkGoals, type GoalState } from './goals';
import { isCityConfig, type CityConfig, type CityEvent, type CityType } from './city';
import type { AirlineRequest, RequestKind } from './airlineEval';
import type { ScoreComponent, ScoreKey } from './airlineScore';

/**
 * 空港会社（経営）の状態。建設モードと運航モードをまたいで保持し、レイアウトと一緒に保存する。
 * docs/14_management_rules.md
 */

export type RevenueCategory = 'contract' | 'landing' | 'parking' | 'terminal' | 'groundHandling' | 'retail' | 'dining' | 'carPark' | 'transit' | 'hotel';
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
  | 'disruption';
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
];

export type TimeWindow = 'morning' | 'daytime' | 'evening' | 'any';

export interface Contract {
  id: string;
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
  for (const a of AIRLINES) airlines[a.id] = { satisfaction: 60, lowDays: 0 };
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
  return Object.fromEntries(AIRLINES.map((a) => [a.id, a.fleet.map((e) => ({ ...e }))]));
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
  if (!c.fleets[k.airlineId]?.some((e) => e.typeId === typeId)) return { ok: false, reason: 'NOT_IN_FLEET' };
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

export type ContractActionResult = { ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_OFFERED' | 'NOT_ACTIVE' | 'UNSUPPORTED' | 'AIRLINE_REFUSED' | 'MIN_FREQUENCY' };

/** 提案を受け入れる（翌運航日から有効）。supported = 空港で運航可能な機種か */
export function acceptOffer(c: CompanyState, id: string, supported: boolean): ContractActionResult {
  const k = c.contracts[id];
  if (!k) return { ok: false, reason: 'NOT_FOUND' };
  if (k.status !== 'offered') return { ok: false, reason: 'NOT_OFFERED' };
  if (!supported) return { ok: false, reason: 'UNSUPPORTED' };

  // 新規契約の受諾時に、過去の撤退カウントをリセットする
  c.airlines[k.airlineId]!.lowDays = 0;

  k.status = 'active';
  k.startDay = c.day;
  k.endDay = c.day + BALANCE.offers.contractDays - 1;
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
export function changeFrequency(c: CompanyState, id: string, delta: 1 | -1): ContractActionResult {
  const k = c.contracts[id];
  if (!k) return { ok: false, reason: 'NOT_FOUND' };
  if (k.status !== 'active') return { ok: false, reason: 'NOT_ACTIVE' };
  const rel = c.airlines[k.airlineId]!;
  if (delta > 0) {
    if (rel.satisfaction < BALANCE.contracts.increaseMinSat - increaseMinSatRelief(c, k.airlineId)) return { ok: false, reason: 'AIRLINE_REFUSED' };
    k.perDay += 1;
  } else {
    if (k.perDay <= 1) return { ok: false, reason: 'MIN_FREQUENCY' };
    k.perDay -= 1;
    rel.satisfaction = Math.max(0, rel.satisfaction - BALANCE.contracts.decreasePenaltySat);
  }
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
export function generateOffers(c: CompanyState, operable: readonly AircraftTypeId[]): Contract[] {
  const out: Contract[] = [];
  const open = () => contractsOf(c, 'offered').length;
  withRng(c, (rng) => {
    for (const a of AIRLINES) {
      if (open() >= BALANCE.offers.maxOpen) break;
      const rel = c.airlines[a.id]!;
      const p = (BALANCE.offers.baseProb + BALANCE.offers.ratingProb * (c.rating / 100) * (rel.satisfaction / 60)) * offerBoost(c, a.id);
      if (rng.next() >= p) continue;
      const served = new Set(contractsOf(c).filter((k) => k.airlineId === a.id && (k.status === 'active' || k.status === 'offered')).map((k) => k.destinationId));
      const dests = DESTINATIONS.filter((d) => !served.has(d.id));
      if (dests.length === 0) continue;
      const dest = dests[rng.int(0, dests.length - 1)]!;
      // 運航できる機種を優先しつつ、評価が高いと大型機の提案も来る
      const own = (c.fleets[a.id] ?? a.fleet).map((e) => e.typeId);
      if (own.length === 0) continue;
      const fleet = own.filter((t) => operable.includes(t) || (resolveType(AIRCRAFT_TYPES, t).size === 'L' && c.rating >= 60 && !aircraftIsLow(c, a.id)) || rng.next() < 0.25);
      const typeId = (fleet.length > 0 ? fleet : own)[rng.int(0, (fleet.length > 0 ? fleet : own).length - 1)]!;
      const maxPerDay = (c.rating >= 70 ? 4 : c.rating >= 50 ? 3 : 2) + tierBonus(c);
      const windows: TimeWindow[] = ['morning', 'daytime', 'evening', 'any'];
      const discount =
        a.type === 'lcc' ? 0.2 + rng.next() * 0.2 : a.type === 'regional' ? 0.1 + rng.next() * 0.15 : rng.next() * 0.15;
      out.push(
        addContract(c, {
          airlineId: a.id,
          destinationId: dest.id,
          typeId,
          perDay: rng.int(1, maxPerDay),
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
export function updateContracts(c: CompanyState, results: Record<string, AirlineDayResult>, ev?: { deltas: Record<string, number>; bonus: Record<string, number> }): string[] {
  const events: string[] = [];
  const feeRatio = (c.fees.landing + c.fees.terminal + c.fees.parking) / 3;
  for (const a of AIRLINES) {
    const rel = c.airlines[a.id]!;
    const r = results[a.id];
    const hasContract = contractsOf(c, 'active').some((k) => k.airlineId === a.id);
    if (!hasContract && !r) continue;
    let delta = 0;
    if (ev) {
      // 評価要素から計算した変化（定時率・乗り遅れ・料金は要素に含まれる）。欠航のペナルティだけ従来どおり別に引く
      delta = (ev.deltas[a.id] ?? 0) + (ev.bonus[a.id] ?? 0);
      if (r && r.flights > 0) delta -= cancelPenalty(r);
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
      if (rel.satisfaction >= BALANCE.contracts.renewGoodSat && complaintCount(c, k.airlineId) < COMPLAINTS_BLOCK_INCREASE) {
        k.endDay = c.day + BALANCE.offers.contractDays;
        k.perDay += 1;
        events.push(`${airlineDef(k.airlineId).name} が契約を増便して更新しました`);
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
    ['SK', 'TWN', 'B737-800W', 3, 'any'],
    ['SK', 'HSM', 'B777-300ER', 1, 'daytime'],
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
    // Phase 5 の保存データ: アクセス関連の項目を補う
    c.fees = Object.assign({ carPark: 1, taxi: 1, bus: 1, rail: 1 }, c.fees);
    c.accessFeedback ??= { ...NO_FEEDBACK, waitMin: {} };
    c.parkedCars ??= [];
    c.projects ??= {};
    // 12B-3a: ゲームの設定の形が不正なら捨てて従来のルールに戻す（読み込みは止めない。厳格な検証は validateProject）
    if (c.game !== undefined && checkGameSettings(c.game) !== null) delete c.game;
    if (c.airlineEval !== undefined && checkAirlineEval(c.airlineEval).length > 0) delete c.airlineEval;
    if (c.goals !== undefined && checkGoals(c.goals).length > 0) delete c.goals;
    if (c.city !== undefined && !isCityConfig(c.city)) delete c.city;
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
