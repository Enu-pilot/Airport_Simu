import type { FlightRecord } from '../analytics/records';
import { contractsOf, type CompanyState } from './company';
import { airlineDef } from './registry';

/**
 * 路線市場の状態（フェーズ 3 §2.2 / §4.2）。company.market がある会社だけが対象。
 * 路線需要モデル（demand.ts）で決まる搭乗率の実績を契約ごとに追い、
 * 低迷した契約の減便・撤退と、好調な契約の増便要望（signal）を管理する。
 */
export interface RouteMarketState {
  /** 搭乗率の指数移動平均（0.7 / 0.3） */
  lfEma: number;
  /** 基準を大きく下回った連続日数 */
  lowDays: number;
  /** 満席に近い連続日数 */
  highDays: number;
  /** 好調の要望（契約の更新時に消費する） */
  signal?: 'grow';
}

export interface MarketSettings {
  version: 1;
  routes: Record<string, RouteMarketState>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** market の形の厳格な検証（不正は理由の一覧。文体は checkGameSettings に合わせる） */
export function checkMarket(raw: unknown): string[] {
  if (!isObj(raw)) return ['市場設定（market）がオブジェクトではありません'];
  const errors: string[] = [];
  if (raw.version !== 1) errors.push('市場設定（market）の版が不正です');
  if (!isObj(raw.routes)) {
    errors.push('市場設定（market.routes）がオブジェクトではありません');
    return errors;
  }
  for (const [id, r] of Object.entries(raw.routes)) {
    const where = `市場設定（market.routes.${id}）`;
    if (!isObj(r)) {
      errors.push(`${where} がオブジェクトではありません`);
      continue;
    }
    if (typeof r.lfEma !== 'number' || !Number.isFinite(r.lfEma) || r.lfEma < 0 || r.lfEma > 1) errors.push(`${where} の lfEma が不正です（0〜1）`);
    for (const f of ['lowDays', 'highDays'] as const) {
      if (!Number.isInteger(r[f]) || (r[f] as number) < 0 || (r[f] as number) > 10_000) errors.push(`${where} の ${f} が不正です（0〜10000 の整数）`);
    }
    if (r.signal !== undefined && r.signal !== 'grow') errors.push(`${where} の signal が不正です`);
  }
  return errors;
}

/** 契約 1 件の当日の搭乗率（完了した便だけ。欠航は母数に入れない） */
export function contractLoadFactor(records: readonly FlightRecord[], contractId: string): number | null {
  let pax = 0;
  let seats = 0;
  for (const r of records) {
    if (r.contractId !== contractId || r.result === 'cancelled') continue;
    pax += r.paxBooked + r.paxArrived;
    seats += r.seats * 2;
  }
  return seats > 0 ? pax / seats : null;
}

/**
 * 日次の締めで market の状態を進める（計画 §4.2）。ops の締めで updateContracts の前に呼ぶ。
 * routeLf = 就航先 ID → その日の路線の需要÷座席（L_r。demand.ts の routeDemandSummary）。省略時は満席判定をしない。
 * 乱数は使わない。
 */
export function stepMarket(c: CompanyState, records: readonly FlightRecord[], routeLf?: ReadonlyMap<string, number>): string[] {
  const m = c.market;
  if (!m) return [];
  const events: string[] = [];
  const active = new Set<string>();
  for (const k of contractsOf(c, 'active')) {
    active.add(k.id);
    const lf = contractLoadFactor(records, k.id);
    if (lf === null) continue;
    const st = (m.routes[k.id] ??= { lfEma: lf, lowDays: 0, highDays: 0 });
    st.lfEma = 0.7 * st.lfEma + 0.3 * lf;
    const target = airlineDef(k.airlineId).baseLoadFactor;
    st.lowDays = st.lfEma < target - 0.2 ? st.lowDays + 1 : 0;
    const lr = routeLf?.get(k.destinationId);
    st.highDays = st.lfEma > Math.max(0.85, target + 0.1) && lr !== undefined && lr >= 1.0 ? st.highDays + 1 : 0;
    const name = airlineDef(k.airlineId).name;
    if (st.lowDays >= 10 && k.perDay === 1) {
      k.status = 'withdrawn';
      events.push(`${name} が ${k.id} の路線から撤退しました（搭乗率の低迷）`);
      delete m.routes[k.id];
      active.delete(k.id);
    } else if (st.lowDays >= 5 && k.perDay > 1) {
      k.perDay -= 1;
      st.lowDays = 0;
      events.push(`${name} が ${k.id} の便数を減らしました（搭乗率の低迷）`);
    } else if (st.highDays >= 5 && st.signal !== 'grow') {
      st.signal = 'grow';
      events.push(`${name} が ${k.id} の増便を希望しています（搭乗率好調）`);
    }
  }
  // 終わった契約の状態は捨てる
  for (const id of Object.keys(m.routes)) if (!active.has(id)) delete m.routes[id];
  return events;
}
