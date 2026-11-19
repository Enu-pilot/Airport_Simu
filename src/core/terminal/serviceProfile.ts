import type { AirportLayout, PaxZone, TerminalAreaKind } from '../model/types';
import { BALANCE } from '../economy/balance';
import { areaServerCount } from './capacity';
import { PAX_PER_TILE } from './model';

/**
 * 5-19 T11: 店舗・旅客サービス施設のシミュレーション粒度分離 — 共通の集約 profile。
 *
 * 個別施設（ターミナル内エリア: shop / restaurant / waiting）のデータを唯一の元データとし、
 * 空港運営モード（AirportDay）用の「カテゴリ × ターミナル」集約 profile をそこから導出する。
 * 詳細用・運営用に店舗台帳を二重管理しない。profile は layout から決定的に導出される派生データで、
 * 保存形式には含めない（保存/再読込時は layout から再生成する）。
 *
 * 集約値の算出根拠:
 * - 施設数・合計能力（窓口/席数 = areaServerCount）・収容人数（エリア面積 × PAX_PER_TILE、
 *   TerminalModel の AreaNode.capacity と同じ式）は加算する。
 * - 滞在時間・1人あたり売上は、既存の運航モデルが使う BALANCE.retail の定数
 *   （shop: shopSec/shopPerPax、restaurant: restaurantSec/restaurantPerPax）をそのまま使う。
 *   カテゴリは単一のエリア種別に対応するため重み付け平均は不要で、値は根拠のある定数である。
 * - 価格帯・サービス品質は既存モデルに算出根拠（エリア属性・計算式）が存在しないため、
 *   捏造せず常に未算出（null）とする。
 * - 待合（waiting）は購買カテゴリではない。滞留時間は搭乗時刻に依存し固定値の根拠がないため
 *   dwellSec は未算出（null）、売上も未算出（null）。収容能力と区域分布だけを集約する。
 * - ラウンジ（5-19 2A でエリア種別 'lounge' を新設）: 購買カテゴリではない。shop/restaurant の
 *   派生ではなく、席数ベースの収容と「搭乗までの滞在の質」を持つ独立カテゴリとして扱う。
 *   処理能力は窓口数（areaServerCount）ではなく席数（props.seats）。滞在時間は待合と同じく
 *   搭乗時刻依存で固定値の根拠がないため dwellSec は未算出（null）、売上も持たない（null）。
 *   利用資格は isLoungeEligible（区域・所属ターミナルの運用状態・席数）で判定し、実際の
 *   到達可能性は経路探索（findPaxRoute）が決める。航空会社のクラス/ステータスによる資格は
 *   既存モデルに旅客属性が存在しないため未対応（新設しない）。
 *
 * キャッシュ: layout オブジェクトは編集操作ごとに新しいオブジェクトになる（layout/operations は
 * 不変更新）ため、WeakMap のキー同一性がそのまま無効化条件になる。レイアウトが変われば新しい
 * オブジェクトに対して再生成され、変わらなければ再走査しない。運航 tick では再生成しない。
 */

export type ServiceCategory = 'retail' | 'dining' | 'lounge' | 'waiting';

export const SERVICE_CATEGORIES: readonly ServiceCategory[] = ['retail', 'dining', 'lounge', 'waiting'];

const AREA_CATEGORY: Partial<Record<TerminalAreaKind, ServiceCategory>> = {
  shop: 'retail',
  restaurant: 'dining',
  lounge: 'lounge',
  waiting: 'waiting',
};

/** エリア種別 → サービスカテゴリ。対象外の種別は null */
export function serviceCategoryOfAreaKind(kind: TerminalAreaKind): ServiceCategory | null {
  return AREA_CATEGORY[kind] ?? null;
}

/** カテゴリに対応するエリア種別 */
export function areaKindOfServiceCategory(category: ServiceCategory): TerminalAreaKind | null {
  if (category === 'retail') return 'shop';
  if (category === 'dining') return 'restaurant';
  if (category === 'lounge') return 'lounge';
  if (category === 'waiting') return 'waiting';
  return null;
}

/** ラウンジの席数（props.seats）。未設定・不正値は 0 */
export function loungeSeats(props: Record<string, unknown> | undefined): number {
  const v = props?.seats;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * ラウンジの利用資格（5-19 2A）: 区域・所属ターミナルの運用状態・席数で決まる。
 * - 区域: 保安検査後の出発区域（departure / departureIntl）にあること。一般区域・到着区域の
 *   ラウンジは資格なし（配置はできるが利用対象にならない）。
 * - 所属ターミナルが運用中であること、席数が 1 以上であること。
 * 実際の到達可能性（経路の有無・区域制約）はここでは判定せず、利用側の経路探索
 * （詳細モードの findPaxRoute）が運航側と同じ規則で決める。
 * 航空会社のクラス/ステータスによる資格は、既存モデルに該当する旅客属性がないため未対応。
 */
export function isLoungeEligible(facility: ServiceFacilityProfile): boolean {
  return (
    facility.category === 'lounge' &&
    facility.operational &&
    (facility.zone === 'departure' || facility.zone === 'departureIntl') &&
    facility.capacity > 0
  );
}

/** 個別施設（エリア）単位の profile。詳細モードと集約の共通の元データ表現 */
export interface ServiceFacilityProfile {
  areaId: string;
  terminalId: string;
  category: ServiceCategory;
  kind: TerminalAreaKind;
  zone: PaxZone;
  level: number;
  /**
   * 処理能力: 通常は areaServerCount(area.props)（既存運航の serversOf と同じ根拠）。
   * ラウンジだけは窓口処理ではないため席数（props.seats = loungeSeats）を使う。
   */
  capacity: number;
  /** 収容人数の目安: エリア面積 × PAX_PER_TILE（TerminalModel の AreaNode.capacity と同じ式） */
  areaCapacity: number;
  /** 滞在時間（秒）の根拠値。根拠がないカテゴリは null（未算出） */
  dwellSec: number | null;
  /** 1人あたり売上の根拠値。根拠がないカテゴリは null（未算出） */
  spendPerPax: number | null;
  /** 所属ターミナル施設が運用中か（buildState）。エリア自体に営業状態はなく、建物の運用状態で決まる */
  operational: boolean;
}

export type ServiceCategoryStatus = 'available' | 'notOperational' | 'notConfigured';

export interface ServiceZoneProfile {
  zone: PaxZone;
  facilityCount: number;
  totalCapacity: number;
}

/** カテゴリ × ターミナルの集約 profile（空港運営モード用） */
export interface ServiceCategoryProfile {
  terminalId: string;
  category: ServiceCategory;
  status: ServiceCategoryStatus;
  /** 設置数（運用状態を問わない） */
  facilityCount: number;
  /** 運用中の施設数 */
  operationalFacilityCount: number;
  /** 運用中施設の合計処理能力 */
  totalCapacity: number;
  /** 運用中施設の合計収容人数 */
  totalAreaCapacity: number;
  /** 滞在時間（秒）の根拠値（カテゴリ=単一種別のため定数）。未算出は null */
  dwellSec: number | null;
  /** 1人あたり売上の根拠値。未算出は null */
  spendPerPax: number | null;
  /** 価格帯・サービス品質: 既存モデルに算出根拠がないため常に未算出 */
  priceQuality: null;
  /** 区域（ゾーン）別の分布。局所的な配置差を消さないための内訳 */
  byZone: ServiceZoneProfile[];
  /** 個別施設の ID 一覧（詳細モード・診断導線との対応付け用） */
  facilityIds: string[];
}

export interface ServiceProfiles {
  /** 個別施設 profile（エリア ID 順） */
  facilities: ServiceFacilityProfile[];
  /** `${terminalId}|${category}` → 集約 profile。全ターミナル × 全カテゴリのキーを必ず持つ */
  byTerminalCategory: Map<string, ServiceCategoryProfile>;
  /** ターミナル ID（ID 順） */
  terminals: string[];
}

export const serviceProfileKey = (terminalId: string, category: ServiceCategory): string => `${terminalId}|${category}`;

function dwellAndSpend(kind: TerminalAreaKind): { dwellSec: number | null; spendPerPax: number | null } {
  if (kind === 'shop') return { dwellSec: BALANCE.retail.shopSec, spendPerPax: BALANCE.retail.shopPerPax };
  if (kind === 'restaurant') return { dwellSec: BALANCE.retail.restaurantSec, spendPerPax: BALANCE.retail.restaurantPerPax };
  return { dwellSec: null, spendPerPax: null };
}

/** layout から集約 profile を生成する（純粋関数・決定的） */
export function buildServiceProfiles(layout: AirportLayout): ServiceProfiles {
  const facilities: ServiceFacilityProfile[] = [];
  const terminalIds = new Set<string>();
  for (const a of Object.values(layout.terminalAreas)) {
    const category = serviceCategoryOfAreaKind(a.kind);
    if (!category) continue;
    const terminal = layout.facilities[a.terminalId];
    if (!terminal) continue;
    terminalIds.add(a.terminalId);
    const { dwellSec, spendPerPax } = dwellAndSpend(a.kind);
    facilities.push({
      areaId: a.id,
      terminalId: a.terminalId,
      category,
      kind: a.kind,
      zone: a.zone,
      level: a.level,
      capacity: a.kind === 'lounge' ? loungeSeats(a.props) : areaServerCount(a.props),
      areaCapacity: Math.max(10, a.w * a.h * PAX_PER_TILE),
      dwellSec,
      spendPerPax,
      operational: (terminal.buildState ?? 'operational') === 'operational',
    });
  }
  facilities.sort((x, y) => (x.areaId < y.areaId ? -1 : x.areaId > y.areaId ? 1 : 0));
  // ターミナル施設があってもサービスエリアを持たないターミナルもキーを持つ（未設置の明示）
  for (const f of Object.values(layout.facilities)) if (f.kind === 'terminal') terminalIds.add(f.id);
  const terminals = [...terminalIds].sort();
  const byTerminalCategory = new Map<string, ServiceCategoryProfile>();
  for (const terminalId of terminals) {
    for (const category of SERVICE_CATEGORIES) {
      const list = facilities.filter((f) => f.terminalId === terminalId && f.category === category);
      const open = list.filter((f) => f.operational);
      const byZoneMap = new Map<PaxZone, ServiceZoneProfile>();
      for (const f of open) {
        const z = byZoneMap.get(f.zone) ?? { zone: f.zone, facilityCount: 0, totalCapacity: 0 };
        z.facilityCount += 1;
        z.totalCapacity += f.capacity;
        byZoneMap.set(f.zone, z);
      }
      const kind = areaKindOfServiceCategory(category);
      const basis = kind ? dwellAndSpend(kind) : { dwellSec: null, spendPerPax: null };
      byTerminalCategory.set(serviceProfileKey(terminalId, category), {
        terminalId,
        category,
        status: list.length === 0 ? 'notConfigured' : open.length === 0 ? 'notOperational' : 'available',
        facilityCount: list.length,
        operationalFacilityCount: open.length,
        totalCapacity: open.reduce((s, f) => s + f.capacity, 0),
        totalAreaCapacity: open.reduce((s, f) => s + f.areaCapacity, 0),
        dwellSec: basis.dwellSec,
        spendPerPax: basis.spendPerPax,
        priceQuality: null,
        byZone: [...byZoneMap.values()].sort((x, y) => (x.zone < y.zone ? -1 : 1)),
        facilityIds: list.map((f) => f.areaId),
      });
    }
  }
  return { facilities, byTerminalCategory, terminals };
}

const profileCache = new WeakMap<AirportLayout, ServiceProfiles>();

/**
 * layout 単位でキャッシュされた profile を返す。同一 layout オブジェクトでは再走査しない。
 * レイアウト変更は新しい layout オブジェクトを生むため、それがそのまま無効化条件になる。
 */
export function serviceProfilesFor(layout: AirportLayout): ServiceProfiles {
  const hit = profileCache.get(layout);
  if (hit) return hit;
  const built = buildServiceProfiles(layout);
  profileCache.set(layout, built);
  return built;
}

export function categoryProfile(profiles: ServiceProfiles, terminalId: string, category: ServiceCategory): ServiceCategoryProfile | null {
  return profiles.byTerminalCategory.get(serviceProfileKey(terminalId, category)) ?? null;
}

/* ------------------------------------------------------------------ */
/* 実績の集約（詳細モード実績 → カテゴリ → ターミナル → 空港全体）      */
/* ------------------------------------------------------------------ */

/** 店舗別実績（詳細モードが記録する最小単位） */
export interface ServiceFacilityRecord {
  areaId: string;
  /** 利用した旅客数（人） */
  users: number;
  /** 利用グループ/batch 数 */
  groups: number;
  /** 待ち時間の合計（人秒ではなくグループ秒×人数の重み付き = 人秒） */
  waitPaxSec: number;
  /** 滞在時間の合計（人秒） */
  dwellPaxSec: number;
  /** 売上（既存収支と同じ通貨単位。根拠のないカテゴリは 0 でなく集計対象外として扱う） */
  revenue: number;
  /** 処理に使われた能力時間（窓口秒）: 稼働率の分子 */
  busyServerSec: number;
  /** 満員・容量不足で利用できなかった人数 */
  turnedAway: number;
}

export interface ServiceCategoryRecord {
  category: ServiceCategory;
  users: number;
  groups: number;
  waitPaxSec: number;
  dwellPaxSec: number;
  revenue: number;
  busyServerSec: number;
  turnedAway: number;
  /** 平均待ち（秒/人）。users=0 のときは未算出 null */
  avgWaitSec: number | null;
  /** 平均滞在（秒/人）。users=0 のときは未算出 null */
  avgDwellSec: number | null;
}

const emptyRecord = (): ServiceFacilityRecord => ({
  areaId: '', users: 0, groups: 0, waitPaxSec: 0, dwellPaxSec: 0, revenue: 0, busyServerSec: 0, turnedAway: 0,
});

function rollup(records: Iterable<ServiceFacilityRecord>): Omit<ServiceCategoryRecord, 'category' | 'avgWaitSec' | 'avgDwellSec'> {
  const out = emptyRecord();
  for (const r of records) {
    out.users += r.users;
    out.groups += r.groups;
    out.waitPaxSec += r.waitPaxSec;
    out.dwellPaxSec += r.dwellPaxSec;
    out.revenue += r.revenue;
    out.busyServerSec += r.busyServerSec;
    out.turnedAway += r.turnedAway;
  }
  return out;
}

function withAverages(category: ServiceCategory, base: ReturnType<typeof rollup>): ServiceCategoryRecord {
  return {
    category,
    ...base,
    avgWaitSec: base.users > 0 ? base.waitPaxSec / base.users : null,
    avgDwellSec: base.users > 0 ? base.dwellPaxSec / base.users : null,
  };
}

/**
 * 店舗別実績をカテゴリ別 → ターミナル別 → 空港全体へ集約する共通 adapter。
 * 詳細モードの実績と空港運営モードの集約実績は、同じ定義・単位・範囲でこの形にそろえる
 * （比較可能にするため。粒度が違うため数値の完全一致は要求しない）。
 */
export function aggregateServiceRecords(
  profiles: ServiceProfiles,
  records: ReadonlyMap<string, ServiceFacilityRecord>,
): {
  byCategory: Map<string, ServiceCategoryRecord>;
  byTerminal: Map<string, ServiceCategoryRecord[]>;
  airport: ServiceCategoryRecord[];
} {
  const byCategory = new Map<string, ServiceCategoryRecord>();
  const byTerminal = new Map<string, ServiceCategoryRecord[]>();
  const airportBase = new Map<ServiceCategory, ReturnType<typeof rollup>>();
  for (const terminalId of profiles.terminals) {
    const list: ServiceCategoryRecord[] = [];
    for (const category of SERVICE_CATEGORIES) {
      const profile = categoryProfile(profiles, terminalId, category)!;
      const base = rollup(profile.facilityIds.map((id) => records.get(id) ?? emptyRecord()));
      const rec = withAverages(category, base);
      byCategory.set(serviceProfileKey(terminalId, category), rec);
      list.push(rec);
      const acc = airportBase.get(category) ?? emptyRecord();
      acc.users += base.users; acc.groups += base.groups; acc.waitPaxSec += base.waitPaxSec;
      acc.dwellPaxSec += base.dwellPaxSec; acc.revenue += base.revenue;
      acc.busyServerSec += base.busyServerSec; acc.turnedAway += base.turnedAway;
      airportBase.set(category, acc);
    }
    byTerminal.set(terminalId, list);
  }
  const airport = SERVICE_CATEGORIES.map((c) => withAverages(c, airportBase.get(c) ?? emptyRecord()));
  return { byCategory, byTerminal, airport };
}
