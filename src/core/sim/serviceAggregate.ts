import { BALANCE } from '../economy/balance';
import { onShopDone } from '../economy/ops';
import {
  categoryProfile,
  serviceProfileKey,
  type ServiceCategory,
} from '../terminal/serviceProfile';
import type { Simulation } from './simulation';
import type { PaxGroup } from './types';

/**
 * 5-19 T11/T12: 空港運営モード（AirportDay）のカテゴリ集約による店舗利用。
 *
 * 詳細モード（従来の planShop）は店舗エリアを個別に選び、findPaxRoute で実際に歩かせ、
 * 店舗ごとの施設キューで処理する。運営モードの集約方式ではそれを行わず、
 * 「カテゴリ × ターミナル」の集約 profile（terminal/serviceProfile）だけを見て
 * 利用可否・滞在・売上を処理する。tick ごとに全店舗を走査せず、profile は
 * SimContext に1回だけ生成され（layout 単位でキャッシュ）、利用中件数は
 * カテゴリ単位のカウンタで管理する。処理量は店舗数に比例しない。
 *
 * 判定の根拠は詳細方式とそろえる:
 * - 搭乗開始までの余裕が BALANCE.retail.minSlackSec 未満なら立寄らない（planShop と同じ）。
 * - 見込み待ちが10分を超えるカテゴリは選ばない（planShop の goals 条件と同じ閾値）。
 *   集約方式の見込み待ちは「滞在時間 × 利用率（利用中グループ数 ÷ 合計能力）」で近似する。
 *   これは集約による近似であり、詳細方式の店舗別キューとは一致しない（計画書に明記）。
 * - 滞在時間と売上は BALANCE.retail の既存定数をそのまま使い、収支への記録も
 *   詳細方式と同じ onShopDone を通す（retail / dining の科目も同一）。
 * - 待合カテゴリは購買ではないため、この集約利用の対象にしない（搭乗前の滞留は
 *   従来どおり待合エリア/ロビーでの dwell が担う）。
 */

export type ServiceGranularity = 'detailed' | 'aggregate';

/** カテゴリ × ターミナルの集約利用実績（運営モード。詳細モードの実績集約と同じ定義・単位） */
export interface ServiceCategoryUsage {
  users: number;
  groups: number;
  dwellPaxSec: number;
  revenue: number;
  /** 余裕不足・混雑で立寄りをやめた人数 */
  skipped: number;
}

export interface ServiceAggregateRuntime {
  /** `${terminalId}|${category}` → 現在滞在中のグループ数 */
  active: Map<string, number>;
  /** `${terminalId}|${category}` → 集約利用実績 */
  usage: Map<string, ServiceCategoryUsage>;
}

export function createServiceAggregateRuntime(): ServiceAggregateRuntime {
  return { active: new Map(), usage: new Map() };
}

export function serviceRuntimeOf(sim: Simulation): ServiceAggregateRuntime {
  if (!sim.serviceRuntime) sim.serviceRuntime = createServiceAggregateRuntime();
  return sim.serviceRuntime;
}

/** 運営モードの集約利用実績（UI・診断向けの読み取り口。Step 5 引き渡し参照） */
export function serviceAggregateUsage(sim: Simulation): ReadonlyMap<string, ServiceCategoryUsage> {
  return serviceRuntimeOf(sim).usage;
}

const VISIT_CATEGORIES: readonly ServiceCategory[] = ['retail', 'dining'];
const MAX_EXPECTED_WAIT_SEC = 10 * 60;

/**
 * 'shop' ステップの集約処理。立寄りを開始したら true（呼び出し側はここで終える）。
 * 立寄らない場合は advance（stepIndex を進めて次を計画する、passengers 側の処理）を
 * 呼んでから true を返す。集約方式が使えない状況（profile が無い等）だけ false を返し、
 * 詳細方式へ委ねる。
 */
export function planAggregateShopVisit(
  sim: Simulation,
  g: PaxGroup,
  closed: ReadonlySet<string>,
  slackSec: number,
  advance: () => void,
): boolean {
  const profiles = sim.ctx.service;
  const terminalId = g.terminalId ?? sim.ctx.paxTerminal;
  if (!terminalId) return false;
  const runtime = serviceRuntimeOf(sim);
  // slackSec は呼び出し側（planShop）が boardingLeadSec を差し引いて計算した余裕。詳細方式と同一の閾値で判定する
  let best: { category: ServiceCategory; kind: 'shop' | 'restaurant'; dwellSec: number; key: string } | null = null;
  let bestWait = Infinity;
  for (const category of VISIT_CATEGORIES) {
    const profile = categoryProfile(profiles, terminalId, category);
    if (!profile || profile.status !== 'available' || profile.dwellSec === null) continue;
    // 閉鎖中でない運用中施設の能力だけを使う（profile は layout 由来なので閉鎖はここで差し引く）
    const facilityById = new Map(profiles.facilities.map((f) => [f.areaId, f]));
    let openCapacity = 0;
    for (const id of profile.facilityIds) {
      const f = facilityById.get(id)!;
      if (f.operational && !closed.has(id)) openCapacity += f.capacity;
    }
    if (openCapacity <= 0) continue;
    const key = serviceProfileKey(terminalId, category);
    const active = runtime.active.get(key) ?? 0;
    const expectedWait = profile.dwellSec * (active / openCapacity);
    if (expectedWait > MAX_EXPECTED_WAIT_SEC) continue;
    if (expectedWait < bestWait) {
      bestWait = expectedWait;
      best = {
        category,
        kind: category === 'retail' ? 'shop' : 'restaurant',
        dwellSec: profile.dwellSec,
        key,
      };
    }
  }
  const usageOf = (category: ServiceCategory): ServiceCategoryUsage => {
    const key = serviceProfileKey(terminalId, category);
    const u = runtime.usage.get(key) ?? { users: 0, groups: 0, dwellPaxSec: 0, revenue: 0, skipped: 0 };
    runtime.usage.set(key, u);
    return u;
  };
  if (!best || slackSec < BALANCE.retail.minSlackSec) {
    // 立寄らない。詳細方式と同じく任意ステップとして読み飛ばす
    if (best) usageOf(best.category).skipped += g.count;
    advance();
    return true;
  }
  runtime.active.set(best.key, (runtime.active.get(best.key) ?? 0) + 1);
  const u = usageOf(best.category);
  u.groups += 1;
  u.users += g.count;
  u.dwellPaxSec += best.dwellSec * g.count;
  g.aggService = { kind: best.kind, key: best.key };
  g.state = 'inService';
  g.facility = null;
  g.serviceUntil = sim.state.now + best.dwellSec;
  return true;
}

/** 集約滞在の完了処理（stepGroup の inService 完了時に passengers から呼ぶ） */
export function completeAggregateService(sim: Simulation, g: PaxGroup): void {
  const agg = g.aggService;
  if (!agg) return;
  delete g.aggService;
  const runtime = serviceRuntimeOf(sim);
  runtime.active.set(agg.key, Math.max(0, (runtime.active.get(agg.key) ?? 0) - 1));
  // 売上は詳細方式と同一の経路（onShopDone → retail/dining 科目）で記録する
  onShopDone(sim, g, agg.kind);
  const u = runtime.usage.get(agg.key);
  if (u) {
    const per = agg.kind === 'shop' ? BALANCE.retail.shopPerPax : BALANCE.retail.restaurantPerPax;
    u.revenue += g.count * per;
  }
}
