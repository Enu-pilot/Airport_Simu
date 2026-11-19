import { Rng } from '../rng';
import { BALANCE } from '../economy/balance';
import type { AirportLayout } from '../model/types';
import { areaServerCount, serviceSecPerPax } from './capacity';
import { buildTerminalModel, type TerminalModel } from './model';
import { findPaxRoute, type PaxRoute } from './route';
import {
  aggregateServiceRecords,
  serviceProfilesFor,
  type ServiceFacilityRecord,
  type ServiceProfiles,
} from './serviceProfile';

/**
 * 5-19 T12: ターミナル詳細モード — 個別店舗への立寄りを持つ独立シミュレーション。
 *
 * 空港運営（AirportDay）の Simulation とは clock / state / seed を共有しない独立エンジン。
 * 対象ターミナルの出発旅客グループ（重み付き batch、1〜5人）を生成し、
 * 入口 → チェックイン → 保安 →（任意: 個別店舗への立寄り）→ 待合で滞留 → 搭乗口、の順に
 * 既存の旅客経路エンジン（buildTerminalModel + findPaxRoute）で実際に移動させる。
 * findPaxRoute は区域制約（未保安の出発区域立入禁止）と Step-free（階段回避）を
 * 運航側と同じ規則で強制する。複合グラフ（networkGraph）のエリア間辺は TerminalModel の
 * リンクと同一費用で構成されており、本エンジンの経路はその上で進行する。
 * なお 5-16 T6（複合グラフへの能力予約・Step-free 統合）は未実装であり、本エンジンは
 * 能力をエリア単位のキューで扱い、Step-free は findPaxRoute の規則で担保する
 * （単純な距離計算への置換はしていない）。
 *
 * 店舗の選択は運航側 planShop と同じ根拠: 候補は運用中・到達可能・見込み待ち10分以内、
 * 選択は「経路コスト + 見込み待ち」の最小。店舗ごとに FIFO キューを持ち、
 * 窓口数 = areaServerCount、処理時間は運航側 serviceSec と同じ定数
 * （shop = BALANCE.retail.shopSec、restaurant = restaurantSec、グループ単位）。
 * 閉店中・建設中相当（所属ターミナルが非運用）・未接続・満員見込みの店舗は選ばない。
 *
 * 待合は購買選択に統合しない: 店舗立寄りの有無にかかわらず、搭乗口へ向かうまでの
 * 滞留先として最寄りの待合エリア（なければ出発ロビー）を使い、滞留実績を分けて記録する。
 *
 * 本エンジンの実行は AirportDay の state・company・保存データに一切触れない（layout は読み取りのみ）。
 * 結果の AirportDay への反映は行わない（差分プレビュー+明示適用は UI 側 Step 5 の接続点を使う）。
 */

export interface ServiceDetailOptions {
  terminalId: string;
  /** 独立 seed（空港運航の seed とは別系列） */
  seed?: string;
  /** シミュレーション長（秒） */
  durationSec: number;
  /** tick 幅（秒）。既定 5 */
  tickSec?: number;
  /** 計測用クロック（呼び出し側が注入する。core は実時間へ依存しないため、未指定なら tickMs は 0） */
  nowMs?: () => number;
  /** 出発グループの生成率（グループ/時） */
  groupsPerHour: number;
  /** Step-free 旅客の比率 0..1。既定 0 */
  stepFreeRatio?: number;
  /** 店舗立寄り確率。既定 BALANCE.retail.shopVisitProb */
  visitProb?: number;
  /** 搭乗口へ向かうまでの時間予算（秒）の範囲。既定 45〜100 分 */
  budgetMinSec?: number;
  budgetMaxSec?: number;
}

type StepKind = 'checkIn' | 'security' | 'shop' | 'waiting' | 'gate';

interface DetailGroup {
  id: number;
  count: number;
  stepFree: boolean;
  securityCleared: boolean;
  area: string;
  /** 生成時に固定したステップ列（shop は立寄り希望がある場合だけ含む） */
  steps: StepKind[];
  stepIdx: number;
  walkUntil: number;
  walkDest: string;
  facility: string | null;
  queueSince: number;
  serviceUntil: number;
  dwellUntil: number;
  waitSince: number;
  deadline: number;
  state: 'walking' | 'queue' | 'service' | 'dwelling' | 'done' | 'failed';
  /** 立寄り先として確定した店舗エリア（shop ステップ開始時に選択する） */
  shopAreaId: string | null;
  gateAreaId: string | null;
}

export interface ServiceDetailResult {
  terminalId: string;
  seed: string;
  durationSec: number;
  spawnedGroups: number;
  spawnedPax: number;
  /** 搭乗口へ到達した人数（期限内/期限後を分けて数える） */
  boarded: number;
  boardedLate: number;
  /** 経路不能・施設不足で流れを完了できなかった人数 */
  failed: number;
  /** 終了時点で未完了の人数 */
  unfinished: number;
  /** 店舗立寄りを希望したが、候補なし/混雑で利用できなかった人数 */
  shopSkipped: number;
  /** 店舗別実績（areaId → 実績）。待合エリアの滞留実績もここに含む */
  records: Record<string, ServiceFacilityRecord>;
  /** 待合の滞留実績（areaId → { users, dwellPaxSec }）。records の待合分と同じ値の参照用 */
  waitingRecords: Record<string, { users: number; dwellPaxSec: number }>;
  /** 店舗別 → カテゴリ → ターミナル → 空港全体の集約（aggregateServiceRecords の出力） */
  aggregated: ReturnType<typeof aggregateServiceRecords>;
  routeStats: { calls: number; cacheHits: number; cacheMisses: number };
  /** tick 処理時間（ミリ秒）の実測サマリ（描画は含まない） */
  tickMs: { p50: number; p95: number; max: number };
}

const MAX_EXPECTED_WAIT_SEC = 10 * 60;

export function runServiceDetailSim(layout: AirportLayout, opts: ServiceDetailOptions): ServiceDetailResult {
  const tickSec = opts.tickSec ?? 5;
  const seed = opts.seed ?? 'service-detail';
  const rng = new Rng(`${seed}:${opts.terminalId}`);
  const model: TerminalModel = buildTerminalModel(layout);
  const profiles: ServiceProfiles = serviceProfilesFor(layout);
  const terminalId = opts.terminalId;
  const visitProb = opts.visitProb ?? BALANCE.retail.shopVisitProb;
  const budgetMin = opts.budgetMinSec ?? 45 * 60;
  const budgetMax = opts.budgetMaxSec ?? 100 * 60;

  const areasOfKind = (kind: string): string[] =>
    (model.byTerminal[terminalId] ?? []).filter((id) => model.areas[id]!.kind === kind);
  const entrances = areasOfKind('entrance');
  const gateAnchors = Object.values(model.gates)
    .filter((g) => g.terminalId === terminalId && (g.boarding ?? g.boardingIntl))
    .map((g) => (g.boarding ?? g.boardingIntl)!)
    .sort();
  const shopFacilities = profiles.facilities.filter(
    (f) => f.terminalId === terminalId && (f.category === 'retail' || f.category === 'dining') && f.operational,
  );
  const waitingAreas = areasOfKind('waiting');
  const lobbyAreas = areasOfKind('departureLobby');

  // 経路キャッシュ: (始点|目的地|条件) → 経路。同一レイアウト・同一条件では再探索しない
  const routeCache = new Map<string, PaxRoute | null>();
  const routeStats = { calls: 0, cacheHits: 0, cacheMisses: 0 };
  const routeTo = (g: DetailGroup, dest: string): PaxRoute | null => {
    routeStats.calls++;
    const key = `${g.area}|${dest}|${g.stepFree ? 'sf' : ''}|${g.securityCleared ? 'c' : 'u'}`;
    const hit = routeCache.get(key);
    if (hit !== undefined) {
      routeStats.cacheHits++;
      return hit;
    }
    routeStats.cacheMisses++;
    const route = findPaxRoute(model, {
      from: g.area,
      goals: new Map([[dest, 0]]),
      uncleared: !g.securityCleared,
      stepFree: g.stepFree,
    });
    routeCache.set(key, route);
    return route;
  };
  const nearestRoute = (g: DetailGroup, dests: string[]): { dest: string; route: PaxRoute } | null => {
    let best: { dest: string; route: PaxRoute } | null = null;
    for (const dest of dests) {
      const route = routeTo(g, dest);
      if (route && (!best || route.cost < best.route.cost)) best = { dest, route };
    }
    return best;
  };

  // 施設キュー（エリア単位。運航側の facilities と同じ FIFO + 窓口数の考え方）
  interface FacilityRuntime { queue: DetailGroup[]; inService: DetailGroup[] }
  const facilityRuntime = new Map<string, FacilityRuntime>();
  const runtimeOf = (areaId: string): FacilityRuntime => {
    const r = facilityRuntime.get(areaId) ?? { queue: [], inService: [] };
    facilityRuntime.set(areaId, r);
    return r;
  };
  const serversOfArea = (areaId: string): number => areaServerCount(layout.terminalAreas[areaId]!.props);
  const serviceSecFor = (areaId: string, g: DetailGroup): number => {
    const a = layout.terminalAreas[areaId]!;
    if (a.kind === 'shop') return BALANCE.retail.shopSec;
    if (a.kind === 'restaurant') return BALANCE.retail.restaurantSec;
    return Math.max(1, Math.round(g.count * serviceSecPerPax(a.kind, a.props)));
  };
  const expectedWaitFor = (areaId: string): number => {
    const r = runtimeOf(areaId);
    const servers = serversOfArea(areaId);
    if (servers <= 0) return Infinity;
    const ahead = r.queue.length + r.inService.length;
    if (ahead < servers) return 0;
    const a = layout.terminalAreas[areaId]!;
    const unit = a.kind === 'shop' ? BALANCE.retail.shopSec : a.kind === 'restaurant' ? BALANCE.retail.restaurantSec : 60;
    return (ahead / servers) * unit;
  };

  const records = new Map<string, ServiceFacilityRecord>();
  const recordOf = (areaId: string): ServiceFacilityRecord => {
    const r = records.get(areaId) ?? {
      areaId, users: 0, groups: 0, waitPaxSec: 0, dwellPaxSec: 0, revenue: 0, busyServerSec: 0, turnedAway: 0,
    };
    records.set(areaId, r);
    return r;
  };
  const waitingRecords = new Map<string, { users: number; dwellPaxSec: number }>();

  let now = 0;
  let nextId = 1;
  let spawnAcc = 0;
  const groups: DetailGroup[] = [];
  const result: ServiceDetailResult = {
    terminalId, seed, durationSec: opts.durationSec,
    spawnedGroups: 0, spawnedPax: 0, boarded: 0, boardedLate: 0, failed: 0, unfinished: 0, shopSkipped: 0,
    records: {}, waitingRecords: {}, aggregated: aggregateServiceRecords(profiles, new Map()),
    routeStats, tickMs: { p50: 0, p95: 0, max: 0 },
  };

  const startWalk = (g: DetailGroup, dest: string, route: PaxRoute): void => {
    g.state = 'walking';
    g.walkDest = dest;
    g.walkUntil = now + Math.max(1, Math.round(route.cost));
  };

  /** 店舗立寄りの候補選択（運航側 planShop と同じ根拠）。選べなければ null */
  const chooseShop = (g: DetailGroup): string | null => {
    let best: { id: string; score: number } | null = null;
    for (const f of shopFacilities) {
      const route = routeTo(g, f.areaId);
      if (!route) continue;
      const wait = expectedWaitFor(f.areaId);
      if (wait > MAX_EXPECTED_WAIT_SEC) continue;
      const score = route.cost + wait;
      if (!best || score < best.score) best = { id: f.areaId, score };
    }
    return best?.id ?? null;
  };

  /** 次のステップの目的地を決めて移動を開始する。到達不能なら failed にする */
  const advance = (g: DetailGroup): void => {
    if (g.stepIdx >= g.steps.length) {
      g.state = 'done';
      return;
    }
    const step = g.steps[g.stepIdx]!;
    if (step === 'gate' || step === 'waiting') {
      const targets = step === 'gate'
        ? (g.gateAreaId ? [g.gateAreaId] : gateAnchors)
        : waitingAreas.length > 0 ? waitingAreas : lobbyAreas;
      let best: { dest: string; route: PaxRoute } | null = null;
      for (const dest of targets) {
        const route = routeTo(g, dest);
        if (route && (!best || route.cost < best.route.cost)) best = { dest, route };
      }
      if (!best) { g.state = 'failed'; result.failed += g.count; return; }
      startWalk(g, best.dest, best.route);
      return;
    }
    if (step === 'shop' && !g.shopAreaId) {
      const chosen = chooseShop(g);
      if (!chosen) {
        result.shopSkipped += g.count;
        g.stepIdx++;
        advance(g);
        return;
      }
      g.shopAreaId = chosen;
    }
    const candidates = step === 'shop' ? [g.shopAreaId!] : areasOfKind(step);
    let best: { dest: string; route: PaxRoute; wait: number } | null = null;
    for (const dest of candidates) {
      if (serversOfArea(dest) <= 0) continue;
      const route = routeTo(g, dest);
      if (!route) continue;
      const wait = expectedWaitFor(dest);
      if (!best || route.cost + wait < best.route.cost + best.wait) best = { dest, route, wait };
    }
    if (!best) { g.state = 'failed'; result.failed += g.count; return; }
    startWalk(g, best.dest, best.route);
  };

  const arriveAtFacility = (g: DetailGroup): void => {
    const areaId = g.walkDest;
    g.area = areaId;
    const r = runtimeOf(areaId);
    g.facility = areaId;
    g.queueSince = now;
    g.state = 'queue';
    r.queue.push(g);
  };

  const tickDurations: number[] = [];
  const totalTicks = Math.max(1, Math.floor(opts.durationSec / tickSec));
  for (let t = 0; t < totalTicks; t++) {
    const tickStart = opts.nowMs ? opts.nowMs() : 0;
    now = t * tickSec;
    // 生成
    spawnAcc += (opts.groupsPerHour * tickSec) / 3600;
    while (spawnAcc >= 1) {
      spawnAcc -= 1;
      if (entrances.length === 0 || gateAnchors.length === 0) break;
      const wantsShop = rng.next() < visitProb;
      const steps: StepKind[] = wantsShop
        ? ['checkIn', 'security', 'shop', 'waiting', 'gate']
        : ['checkIn', 'security', 'waiting', 'gate'];
      const g: DetailGroup = {
        id: nextId++,
        count: rng.int(1, 5),
        stepFree: rng.next() < (opts.stepFreeRatio ?? 0),
        securityCleared: false,
        area: entrances[Math.floor(rng.next() * entrances.length)]!,
        steps,
        stepIdx: 0,
        walkUntil: 0, walkDest: '', facility: null, queueSince: 0, serviceUntil: 0, dwellUntil: 0, waitSince: 0,
        deadline: now + rng.int(budgetMin, budgetMax),
        state: 'walking', shopAreaId: null, gateAreaId: null,
      };
      result.spawnedGroups++;
      result.spawnedPax += g.count;
      groups.push(g);
      advance(g);
    }
    // 移動の到着
    for (const g of groups) {
      if (g.state !== 'walking' || now < g.walkUntil) continue;
      const step = g.steps[g.stepIdx];
      g.area = g.walkDest;
      if (step === 'gate') {
        g.state = 'done';
        if (now <= g.deadline) result.boarded += g.count; else result.boardedLate += g.count;
      } else if (step === 'waiting') {
        g.state = 'dwelling';
        g.waitSince = now;
        // 滞留は「締切 − ゲートまでの歩行時間」まで。締切ちょうどに終えると全員が遅刻になる
        const gateRoute = nearestRoute(g, gateAnchors);
        const walkToGate = gateRoute?.route.cost ?? 0;
        if (gateRoute) g.gateAreaId = gateRoute.dest;
        g.dwellUntil = Math.max(now, g.deadline - walkToGate);
        const w = waitingRecords.get(g.area) ?? { users: 0, dwellPaxSec: 0 };
        w.users += g.count;
        waitingRecords.set(g.area, w);
      } else {
        arriveAtFacility(g);
      }
    }
    // 締切超過: 移動中・行列中・サービス中のグループは搭乗遅れとして確定させる
    for (const g of groups) {
      if (now <= g.deadline) continue;
      if (g.state === 'walking') {
        g.state = 'done';
        result.boardedLate += g.count;
      } else if (g.state === 'queue' || g.state === 'service') {
        const r = g.facility ? facilityRuntime.get(g.facility) : undefined;
        if (r) {
          r.queue = r.queue.filter((x) => x !== g);
          r.inService = r.inService.filter((x) => x !== g);
          if (g.facility) recordOf(g.facility).turnedAway += g.count;
        }
        g.facility = null;
        g.state = 'done';
        result.boardedLate += g.count;
      }
    }
    // キューの処理開始とサービス完了
    for (const [areaId, r] of facilityRuntime) {
      const servers = serversOfArea(areaId);
      for (let i = r.inService.length - 1; i >= 0; i--) {
        const g = r.inService[i]!;
        if (now < g.serviceUntil) continue;
        r.inService.splice(i, 1);
        g.facility = null;
        const a = layout.terminalAreas[areaId]!;
        if (a.kind === 'security') g.securityCleared = true;
        if (a.kind === 'shop' || a.kind === 'restaurant') {
          const rec = recordOf(areaId);
          const f = profiles.facilities.find((x) => x.areaId === areaId)!;
          rec.revenue += g.count * (f.spendPerPax ?? 0);
        }
        g.stepIdx++;
        advance(g);
      }
      while (r.inService.length < servers && r.queue.length > 0) {
        const g = r.queue.shift()!;
        const svc = serviceSecFor(areaId, g);
        g.state = 'service';
        g.serviceUntil = now + svc;
        r.inService.push(g);
        const a = layout.terminalAreas[areaId]!;
        if (a.kind === 'shop' || a.kind === 'restaurant') {
          const rec = recordOf(areaId);
          rec.groups += 1;
          rec.users += g.count;
          rec.waitPaxSec += (now - g.queueSince) * g.count;
          rec.dwellPaxSec += svc * g.count;
          rec.busyServerSec += svc;
        }
      }
    }
    // 待合の滞留終了
    for (const g of groups) {
      if (g.state !== 'dwelling' || now < g.dwellUntil) continue;
      const w = waitingRecords.get(g.area);
      if (w) w.dwellPaxSec += (now - g.waitSince) * g.count;
      g.stepIdx++;
      advance(g);
    }
    tickDurations.push(opts.nowMs ? opts.nowMs() - tickStart : 0);
  }
  // 終了時点で滞留中のグループは、経過分を滞留実績へ加算する
  for (const g of groups) {
    if (g.state !== 'dwelling') continue;
    const w = waitingRecords.get(g.area);
    if (w) w.dwellPaxSec += (now - g.waitSince) * g.count;
  }
  result.unfinished = groups
    .filter((g) => g.state !== 'done' && g.state !== 'failed')
    .reduce((s, g) => s + g.count, 0);
  // 待合の滞留実績を店舗別実績へ統合する（集約 adapter の入力を1本化する）
  for (const [areaId, w] of waitingRecords) {
    const rec = recordOf(areaId);
    rec.users += w.users;
    rec.groups += 0; // 待合はグループ単位の処理ではないため groups は数えない
    rec.dwellPaxSec += w.dwellPaxSec;
  }
  result.records = Object.fromEntries(records);
  result.waitingRecords = Object.fromEntries(waitingRecords);
  result.aggregated = aggregateServiceRecords(profiles, records);
  tickDurations.sort((a, b) => a - b);
  if (tickDurations.length > 0) {
    result.tickMs = {
      p50: tickDurations[Math.floor(tickDurations.length * 0.5)]!,
      p95: tickDurations[Math.floor(tickDurations.length * 0.95)]!,
      max: tickDurations[tickDurations.length - 1]!,
    };
  }
  return result;
}
