import type { CompanyState, Contract } from './company';
import { featureOn } from './unlocks';
import { airlineDef, destinationDef, routeAvailability, routeCapabilitiesForAirport, type RouteCapabilities } from './registry';
import { AIRCRAFT_TYPES, resolveType, type TypeTable } from '../sim/aircraftTypes';
import type { DayPlan } from './planning';
import type { OperatingHours } from './company';
import type { AirportLayout, SizeClass } from '../model/types';
import { BALANCE } from './balance';

export type CityType = 'regional' | 'core' | 'metropolitan';
export type CityEventKind = 'festival' | 'sports' | 'conference';
export const CITY_EVENT_KINDS: readonly CityEventKind[] = ['festival', 'sports', 'conference'];
export type CityEventLocation = 'cityCenter' | 'airportDistrict';
export interface CityEvent {
  id: string;
  day: number;
  durationDays: number;
  kind: CityEventKind;
  /** 1 = local, 2 = regional, 3 = large */
  scale: 1 | 2 | 3;
  location: CityEventLocation;
  /** 5-07: プレイヤーが協力費を払って予定したイベント（費用と混雑リスクの対象）。欠落 = 従来どおり無償・順調 */
  wagered?: boolean;
}

/** イベントの協力費（cr）。規模の二乗 × 日数に比例する（5-07: 無料の需要増をやめ、判断にする） */
export function cityEventCost(e: Pick<CityEvent, 'scale' | 'durationDays'>): number {
  return e.scale * e.scale * e.durationDays * 40_000;
}

/** 混雑に転ぶ確率（規模が大きいほど高い） */
export function cityEventRisk(e: Pick<CityEvent, 'scale'>): number {
  return 0.15 + 0.05 * e.scale;
}

/** イベント ID から決定的に [0, 1) を作る（乱数を使わず、保存にも残さない） */
function hash01(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** イベントの結果: 協力費を払ったイベントは ID で決定的に決まる。混雑だと需要の伸びが半分・交通が倍になる */
export function cityEventOutcome(e: CityEvent): 'smooth' | 'congested' {
  if (!e.wagered) return 'smooth';
  return hash01(`event:${e.id}`) < cityEventRisk(e) ? 'congested' : 'smooth';
}

export interface CityConfig {
  version: 1;
  type: CityType;
  population: number;
  /**
   * 出発側の航空市場人口（docs/46）。航空需要式の出発側だけに使い、都市成長・都市格・
   * 都市需要上限には使わない。未設定（旧セーブ）は population にフォールバックする。
   * 羽田再現ケースの 37,000,000 のような広域値はシナリオ側が明示的に設定するもので、
   * 都市タイプから自動設定はしない。
   */
  airMarketPopulation?: number;
  /**
   * 出発側の市場ノード（需要モデル v2、domestic_route_demand_realism_plan）。
   * 目的地カタログの ID（都市市場単位。例: 東京市場なら 'TYO'）を指し、設定された会社の
   * 国内線需要は対称重力モデル（v2）で計算する。未設定（旧セーブ・架空都市）は従来形（v1）。
   * 都市成長・都市格・都市需要上限には使わない。ノードが解決できない場合も v1 にフォールバックする。
   */
  marketNodeId?: string;
  distanceKm: number;
  roadQuality: 1 | 2 | 3 | 4 | 5;
  railQuality: 0 | 1 | 2 | 3 | 4 | 5;
  residents: number;
  /** 防音工事助成の実施レベル（機能E、0〜3）。欠落（旧セーブ）= 0（未実施） */
  soundproofLevel?: number;
  /** 騒音対策費を最後に拠出した日（機能E拡張2、会社日 company.day 基準）。欠落（旧セーブ）= 未拠出 */
  lastNoiseContributionDay?: number;
  events?: CityEvent[];
  /** 出発時刻の制限と夜間の運用（フェーズ 2、docs/40）。欠落 = 従来どおり */
  nightOps?: CityNightOps;
  /** 都市上空の保護区域（5-24）。空港から見た方位の範囲で表す。欠落 = 区域なし */
  protectionSectors?: CityProtectionSector[];
}

/** 都市上空の保護区域: 空港を中心とする方位 [fromDeg, toDeg]（真方位・時計回り、跨ぎ可） */
export interface CityProtectionSector {
  fromDeg: number;
  toDeg: number;
  label?: string;
}

export interface CityNightOps {
  version: 1;
  /** 最終出発時刻（日内の分）。既定 1275（21:15）。範囲 1200〜1305 */
  departureCutoffMin: number;
  /** 夜間にかかる到着の扱い（R10）。フェーズ 2 は出発地で待機のみ */
  inboundPolicy: 'originHold';
  /** 上空の夜間待機の上限（分）。既定 30、範囲 0〜120 */
  airborneHoldMaxMin: number;
  /** 予測離陸が制限開始の何分前を越えたら警告するか。既定 20、範囲 0〜120 */
  warnLeadMin: number;
  /** 持ち越しの危険がある便を優先する。既定 false */
  prioritizeAtRisk: boolean;
}

export const CITY_NIGHT_CURFEW = { fromMin: 22 * 60, toMin: 6 * 60 } as const;

export function isCityNightMovement(at: number): boolean {
  const minute = Math.floor((at % 86_400) / 60);
  return minute >= CITY_NIGHT_CURFEW.fromMin || minute < CITY_NIGHT_CURFEW.toMin;
}

/** 騒音規制を適用する日の次の許可時刻（06:00）。 */
export function nextCityMovementTime(at: number): number {
  const dayStart = Math.floor(at / 86_400) * 86_400;
  const morning = dayStart + CITY_NIGHT_CURFEW.toMin * 60;
  return at < morning ? morning : morning + 86_400;
}

/** 最終出発時刻の既定・範囲（docs/40 R1・R2。既定は制限開始 22:00 の 45 分前 = 21:15） */
export const NIGHT_OPS_DEFAULTS = {
  departureCutoffMin: 1275,
  airborneHoldMaxMin: 30,
  warnLeadMin: 20,
} as const;
export const NIGHT_OPS_RANGES = {
  departureCutoffMin: { min: 1200, max: 1305 },
  airborneHoldMaxMin: { min: 0, max: 120 },
  warnLeadMin: { min: 0, max: 120 },
} as const;

/** 夜間の運用設定の既定値。新規ゲームで都市を選んだときだけ画面から入れる（defaultCity は変えない） */
export function defaultCityNightOps(): CityNightOps {
  return { version: 1, ...NIGHT_OPS_DEFAULTS, inboundPolicy: 'originHold', prioritizeAtRisk: false };
}

const inRange = (v: unknown, r: { min: number; max: number }): boolean => typeof v === 'number' && Number.isInteger(v) && v >= r.min && v <= r.max;

/** nightOps の形の検査。isCityConfig は見ない（不正な都市設定を丸ごと捨てる既存の正規化を巻き込まないため）。project.ts の検証で使う */
export function isCityNightOps(value: unknown): value is CityNightOps {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return o.version === 1
    && o.inboundPolicy === 'originHold'
    && inRange(o.departureCutoffMin, NIGHT_OPS_RANGES.departureCutoffMin)
    && inRange(o.airborneHoldMaxMin, NIGHT_OPS_RANGES.airborneHoldMaxMin)
    && inRange(o.warnLeadMin, NIGHT_OPS_RANGES.warnLeadMin)
    && typeof o.prioritizeAtRisk === 'boolean';
}

/** nightOps の各項目を範囲に収める（画面の入力用。整数に丸める） */
export function clampNightOps(n: CityNightOps): CityNightOps {
  const c = (v: number, r: { min: number; max: number }) => Math.max(r.min, Math.min(r.max, Math.round(Number.isFinite(v) ? v : r.min)));
  return {
    ...n,
    departureCutoffMin: c(n.departureCutoffMin, NIGHT_OPS_RANGES.departureCutoffMin),
    airborneHoldMaxMin: c(n.airborneHoldMaxMin, NIGHT_OPS_RANGES.airborneHoldMaxMin),
    warnLeadMin: c(n.warnLeadMin, NIGHT_OPS_RANGES.warnLeadMin),
  };
}

/**
 * 都市設定があるときの運用時間。`city.nightOps` があれば閉店を最終出発時刻でも切る（フェーズ 2、R5）。
 * 計画の出発 = 到着 + 折り返しなので、到着の上限が closeMin − 折り返し時間となり、出発は最終出発時刻以前に収まる。
 * nightOps なしは従来と同じ（第 2 引数を省略しても同じ）。
 */
export function cityOperatingHours(hours: OperatingHours, city?: CityConfig): OperatingHours {
  const closeMin = city?.nightOps
    ? Math.min(hours.closeMin, CITY_NIGHT_CURFEW.fromMin, city.nightOps.departureCutoffMin)
    : Math.min(hours.closeMin, CITY_NIGHT_CURFEW.fromMin);
  return { ...hours, openMin: Math.max(hours.openMin, CITY_NIGHT_CURFEW.toMin), closeMin };
}

/** 最終出発時刻（日内の分）。nightOps がなければ null（制限なし = 従来どおり） */
export function departureCutoffMin(city: CityConfig | undefined): number | null {
  return city?.nightOps ? city.nightOps.departureCutoffMin : null;
}

/**
 * 手動で足す便の出発が最終出発時刻を過ぎるときの警告（R7。禁止はしない）。nightOps がなければ null。
 * `departureAt` は秒（日をまたぐ値でもよい。日内の分で見る）。
 */
export function departureCutoffIssue(city: CityConfig | undefined, departureAt: number): string | null {
  const cutoff = departureCutoffMin(city);
  if (cutoff === null) return null;
  const minute = Math.floor((((departureAt % 86_400) + 86_400) % 86_400) / 60);
  if (minute <= cutoff) return null;
  const hh = String(Math.floor(cutoff / 60)).padStart(2, '0');
  const mm = String(cutoff % 60).padStart(2, '0');
  return `この出発は最終出発時刻 ${hh}:${mm} を過ぎています。夜間の制限で止まり、翌朝の出発になる可能性があります`;
}

/** 機種ごとのゲーム内騒音ポイント。dB値や現実の曝露量を表さない。 */
export function aircraftNoisePoints(size: SizeClass, engines: number): number {
  const sizePoints: Record<SizeClass, number> = { S: 1, M: 2, L: 3 };
  return sizePoints[size] + Math.max(1, engines) * 0.5;
}

/** 防音工事助成の実施レベル（欠落・不正値は 0 として扱う。検証は isCityConfig 側でも行う） */
export function soundproofLevelOf(city: Pick<CityConfig, 'soundproofLevel'>): number {
  const v = city.soundproofLevel;
  return typeof v === 'number' && Number.isInteger(v) ? Math.max(0, Math.min(BALANCE.noise.soundproof.maxLevel, v)) : 0;
}

/** レベルに応じた騒音ポイントの効きの緩和率（1 = 緩和なし） */
export function soundproofNoiseFactor(level: number): number {
  return BALANCE.noise.soundproof.noiseFactor[level] ?? 1;
}

/** 次のレベルへ上げる費用。最大レベルなら null */
export function nextSoundproofCost(city: Pick<CityConfig, 'soundproofLevel'>): number | null {
  const level = soundproofLevelOf(city);
  return level >= BALANCE.noise.soundproof.maxLevel ? null : BALANCE.noise.soundproof.cost[level]!;
}

/**
 * 防音工事助成の実施（純粋な状態変更のみ。資金チェックと差し引きは呼び出し側）。
 * レベルを 1 つ上げ、住民満足度を即時回復させる。最大レベルなら何もせず null を返す。
 */
export function applySoundproofPurchase(city: CityConfig): { level: number; recovery: number } | null {
  const level = soundproofLevelOf(city);
  if (level >= BALANCE.noise.soundproof.maxLevel) return null;
  const recovery = BALANCE.noise.soundproof.recovery[level]!;
  city.soundproofLevel = level + 1;
  city.residents = Math.max(0, Math.min(100, city.residents + recovery));
  return { level: level + 1, recovery };
}

/**
 * 海上移転係数（機能E拡張1）: 格（goals.tier）に応じた騒音ポイントの効きの軽減率。
 * 格が上がるタイミングで空港が沖合へ移転・拡張した想定。goals が無い会社は格 0 扱い（×1.0）。
 */
export function offshoreNoiseFactor(tier: number): number {
  const t = typeof tier === 'number' && Number.isInteger(tier) ? Math.max(0, tier) : 0;
  return BALANCE.noise.offshore.factorByTier[t] ?? 1;
}

/** 騒音ポイントの効きにかかる最終係数（防音工事 × 海上移転。表示・見込み計算で共用する） */
export function noiseMitigationFactor(city: Pick<CityConfig, 'soundproofLevel'>, tier: number): number {
  return soundproofNoiseFactor(soundproofLevelOf(city)) * offshoreNoiseFactor(tier);
}

/**
 * 住民向け施設の日次プラス合計（機能E拡張2）。運用中（operational）の対象施設だけを数え、
 * 合計は BALANCE.noise.residentFacilities.dailyCap で頭打ちにする。運航シミュレーションには影響しない。
 */
export function residentFacilityBonus(layout: AirportLayout): number {
  const per = BALANCE.noise.residentFacilities.dailyBonus;
  let sum = 0;
  for (const f of Object.values(layout.facilities)) {
    if (f.buildState !== 'operational') continue;
    const bonus = per[f.kind];
    if (bonus !== undefined) sum += bonus;
  }
  return Math.min(BALANCE.noise.residentFacilities.dailyCap, sum);
}

/** 日次騒音影響の追加条件（海上移転の格と住民向け施設のプラス。欠落時は従来どおり） */
export interface NoiseImpactOptions {
  /** 空港の格（goals.tier）。欠落・goals なしは 0（海上移転なし） */
  tier?: number;
  /** 住民向け施設の日次プラス合計（residentFacilityBonus の結果）。上限はこの関数側でも守る */
  facilityBonus?: number;
}

/**
 * 日次の住民満足度の変化量（見込み計算にも使う純関数。状態は変えない）。
 * 防音工事と海上移転は騒音ポイントの効きだけを緩和する（最終係数は両者の積）。
 * 夜間運航 1 件あたり −0.15 はどちらでも緩和しない。
 * 住民向け施設のプラスは回復側に加算し、既存の日次クランプ（−1〜+0.05）の内側で効く。
 */
export function noiseImpactDelta(city: Pick<CityConfig, 'soundproofLevel'>, noisePoints: number, nightMovements: number, opts?: NoiseImpactOptions): number {
  const mitigatedNoise = noisePoints * noiseMitigationFactor(city, opts?.tier ?? 0);
  const facilityBonus = Math.max(0, Math.min(BALANCE.noise.residentFacilities.dailyCap, opts?.facilityBonus ?? 0));
  return Math.max(-1, Math.min(0.05, 0.03 + facilityBonus - mitigatedNoise * 0.0004 - nightMovements * 0.15));
}

export function applyCityNoiseImpact(city: CityConfig, noisePoints: number, nightMovements: number, opts?: NoiseImpactOptions): number {
  const before = city.residents;
  const delta = noiseImpactDelta(city, noisePoints, nightMovements, opts);
  city.residents = Math.max(0, Math.min(100, city.residents + delta));
  return Math.round((city.residents - before) * 100) / 100;
}

/** 騒音対策費の拠出が今日まだ可能か（1 日 1 回まで。day は会社日 company.day） */
export function canMakeNoiseContribution(city: Pick<CityConfig, 'lastNoiseContributionDay'>, day: number): boolean {
  return city.lastNoiseContributionDay !== day;
}

/**
 * 騒音対策費の拠出（機能E拡張2。純粋な状態変更のみ。資金チェックと差し引きは呼び出し側）。
 * 住民満足度を即時回復させる。同日に 2 回目なら何もせず false を返す。
 */
export function applyNoiseContribution(city: CityConfig, day: number): boolean {
  if (!canMakeNoiseContribution(city, day)) return false;
  city.lastNoiseContributionDay = day;
  city.residents = Math.max(0, Math.min(100, city.residents + BALANCE.noise.contribution.recovery));
  return true;
}

export const CITY_TYPES: readonly CityType[] = ['regional', 'core', 'metropolitan'];

export const CITY_PROFILE: Record<CityType, Omit<CityConfig, 'version' | 'residents'>> = {
  // 2026-11-18 PO 判断（5-20 T8）: 旧人口では需要上限が上位の格の旅客要件を下回り到達不能だったため引き上げ。
  // growCity の閾値は基礎人口への相対値なので自動で追随する。既存セーブは人口を保持するため新規ゲームのみに効く
  regional: { type: 'regional', population: 600_000, distanceKm: 25, roadQuality: 2, railQuality: 0 },
  core: { type: 'core', population: 4_000_000, distanceKm: 18, roadQuality: 3, railQuality: 2 },
  metropolitan: { type: 'metropolitan', population: 20_000_000, distanceKm: 30, roadQuality: 4, railQuality: 4 },
};

const TRIP_RATE: Record<CityType, number> = { regional: 0.004, core: 0.006, metropolitan: 0.009 };
const BASE_GROWTH: Record<CityType, number> = { regional: 0.0002, core: 0.0003, metropolitan: 0.0002 };

export function defaultCity(type: CityType = 'regional'): CityConfig {
  return { version: 1, ...CITY_PROFILE[type], residents: 70 };
}

/** 航空需要式の出発側人口（docs/46）。未設定・不正値なら都市人口にフォールバックする */
export function airMarketPopulationOf(city: CityConfig): number {
  const v = city.airMarketPopulation;
  return typeof v === 'number' && Number.isFinite(v) && v >= 1_000 && v <= 50_000_000 ? v : city.population;
}

export function isCityConfig(value: unknown): value is CityConfig {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return c.version === 1
    && CITY_TYPES.includes(c.type as CityType)
    && Number.isFinite(c.population) && Number(c.population) >= 1
    && (c.airMarketPopulation === undefined || (Number.isFinite(c.airMarketPopulation) && Number(c.airMarketPopulation) >= 1_000 && Number(c.airMarketPopulation) <= 50_000_000))
    && (c.marketNodeId === undefined || (typeof c.marketNodeId === 'string' && /^[A-Z][A-Z0-9]{2}$/.test(c.marketNodeId)))
    && Number.isFinite(c.distanceKm) && Number(c.distanceKm) >= 0 && Number(c.distanceKm) <= 500
    && Number.isInteger(c.roadQuality) && Number(c.roadQuality) >= 1 && Number(c.roadQuality) <= 5
    && Number.isInteger(c.railQuality) && Number(c.railQuality) >= 0 && Number(c.railQuality) <= 5
    && Number.isFinite(c.residents) && Number(c.residents) >= 0 && Number(c.residents) <= 100
    && (c.soundproofLevel === undefined || (Number.isInteger(c.soundproofLevel) && Number(c.soundproofLevel) >= 0 && Number(c.soundproofLevel) <= BALANCE.noise.soundproof.maxLevel))
    && (c.lastNoiseContributionDay === undefined || (Number.isInteger(c.lastNoiseContributionDay) && Number(c.lastNoiseContributionDay) >= 0))
    && (c.events === undefined || (Array.isArray(c.events) && c.events.every(isCityEvent)));
}

export function isCityEvent(value: unknown): value is CityEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === 'string' && e.id.length > 0
    && Number.isInteger(e.day) && Number(e.day) >= 0
    && Number.isInteger(e.durationDays) && Number(e.durationDays) >= 1 && Number(e.durationDays) <= 30
    && (e.kind === 'festival' || e.kind === 'sports' || e.kind === 'conference')
    && (e.scale === 1 || e.scale === 2 || e.scale === 3)
    && (e.location === 'cityCenter' || e.location === 'airportDistrict')
    && (e.wagered === undefined || typeof e.wagered === 'boolean');
}

const EVENT_EFFECTS: Record<CityEventKind, { demand: number; traffic: number }> = {
  festival: { demand: 0.06, traffic: 0.09 },
  sports: { demand: 0.08, traffic: 0.12 },
  conference: { demand: 0.1, traffic: 0.07 },
};

/** 混雑に転んだイベントの倍率（正本。需要の伸びはこの割合に抑えられ、交通の増分はこの倍率になる）。表示文言もこの値から組み立てる */
export const CITY_EVENT_CONGESTED = { demandGrowthMul: 0.5, trafficMul: 2 } as const;

export function cityEventEffects(city: CityConfig | undefined, day: number): { events: CityEvent[]; demandMultiplier: number; trafficMultiplier: number } {
  const events = (city?.events ?? []).filter((event) => day >= event.day && day < event.day + event.durationDays);
  let demandMultiplier = 1;
  let trafficMultiplier = 1;
  for (const event of events) {
    const effect = EVENT_EFFECTS[event.kind];
    const congested = cityEventOutcome(event) === 'congested';
    demandMultiplier *= 1 + effect.demand * event.scale * (congested ? CITY_EVENT_CONGESTED.demandGrowthMul : 1);
    trafficMultiplier += effect.traffic * event.scale * (event.location === 'airportDistrict' ? 1.5 : 1) * (congested ? CITY_EVENT_CONGESTED.trafficMul : 1);
  }
  return { events, demandMultiplier: Math.min(1.8, demandMultiplier), trafficMultiplier: Math.min(2.5, trafficMultiplier) };
}

/** 旅客/日。すべてゲーム内のバランス値で、実都市の予測ではない。 */
export function cityDemandCeiling(city: CityConfig, accessFactor: number): number {
  const accessNorm = Math.max(0, Math.min(1, (accessFactor - 0.3) / 0.8));
  return city.population * TRIP_RATE[city.type]
    * Math.exp(-Math.max(0, city.distanceKm - 15) / 60)
    * (0.7 + 0.3 * accessNorm);
}

/** 便計画の旅客を都市需要の上限に合わせる係数。都市を持たない会社には適用しない。 */
export function cityDemandFactor(city: CityConfig, accessFactor: number, expectedDailyPax: number): number {
  return Math.min(1.1, cityDemandCeiling(city, accessFactor) / Math.max(1, expectedDailyPax));
}

/** 日次締めで都市人口を更新する。戻り値はマイルストーン通知。 */
export function growCity(city: CityConfig, dailyPax: number, demandCeiling: number): string[] {
  const basePopulation = CITY_PROFILE[city.type].population;
  const baseRoadQuality = CITY_PROFILE[city.type].roadQuality;
  const previousPopulation = city.population;
  const growth = BASE_GROWTH[city.type]
    + 0.0005 * Math.min(1, dailyPax / Math.max(1, 0.8 * demandCeiling))
      * Math.min(1, city.residents / 70);
  city.population = Math.round(city.population * (1 + growth));
  const events: string[] = [];
  const thresholds = [basePopulation * 1.5, basePopulation * 2];
  for (const threshold of thresholds) {
    if (previousPopulation < threshold && city.population >= threshold) {
      city.roadQuality = Math.min(5, Math.max(city.roadQuality, baseRoadQuality + 1)) as CityConfig['roadQuality'];
      events.push(`都市人口が ${threshold / basePopulation} 倍に達し、都市道路の整備度が ${city.roadQuality} になりました`);
    }
  }
  return events;
}

/**
 * 契約の乗継の上限（キャップ）。ハブ機能が有効な会社でのみ効く（planConnections と同じ条件）。
 * 実際に乗り継ぐ割合は需要モデル（docs/44 §4.2）が上限以下で決める。ここでは計画前の
 * 見積もり（都市需要上限の地元分の割合など）に使うため、上限基準の値を返す。
 */
export function contractTransferShare(company: CompanyState, contract: Pick<Contract, 'transferShare'>): number {
  return featureOn(company, 'hub') ? (contract.transferShare ?? 0) : 0;
}

/** 契約便の基本搭乗率から計画旅客数を推定する。 */
export function expectedPassengers(
  company: CompanyState,
  day: number,
  types: TypeTable = AIRCRAFT_TYPES,
  routeCapabilities: RouteCapabilities = routeCapabilitiesForAirport(),
): number {
  return expectedPassengersWeighted(company, day, types, routeCapabilities, false);
}

/**
 * 地元需要分の推定（5-20 T8 の PO 判断: 乗継旅客は地元需要ではない）。
 * 到着旅客のうち乗継分は都市が生む需要ではないので、往復の重みは到着側だけ (1 − share) になり (2 − share)。
 * 都市需要上限の係数はこの地元分に対して効かせる。
 */
export function expectedLocalPassengers(
  company: CompanyState,
  day: number,
  types: TypeTable = AIRCRAFT_TYPES,
  routeCapabilities: RouteCapabilities = routeCapabilitiesForAirport(),
): number {
  return expectedPassengersWeighted(company, day, types, routeCapabilities, true);
}

function expectedPassengersWeighted(
  company: CompanyState,
  day: number,
  types: TypeTable,
  routeCapabilities: RouteCapabilities,
  localOnly: boolean,
): number {
  return Object.values(company.contracts).reduce((sum, contract) => {
    if (contract.status !== 'active' || contract.startDay > day || contract.endDay < day) return sum;
    const airline = airlineDef(contract.airlineId);
    if (routeAvailability(airline, destinationDef(contract.destinationId), routeCapabilities) !== 'available') return sum;
    const seats = company.fleets?.[contract.airlineId]?.find((entry) => entry.typeId === contract.typeId)?.seats
      ?? resolveType(types, contract.typeId).seats;
    const baseLoad = BALANCE.demand.baseLoadFactor[airline.type];
    const share = localOnly ? contractTransferShare(company, contract) : 0;
    return sum + contract.perDay * seats * baseLoad * (2 - share);
  }, 0);
}

export function dailyPlanPassengerCount(plan: DayPlan): number {
  return plan.flights.reduce((sum, flight) => sum + flight.arrPax + flight.depPax, 0);
}

