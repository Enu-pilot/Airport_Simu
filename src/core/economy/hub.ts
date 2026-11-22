import { Rng } from '../rng';
import { compareIds } from '../model/ids';
import type { CompanyState, Contract } from './company';
import type { DayPlan, PlannedFlight } from './planning';
import { transferKindOf, type HubAnalysis } from '../terminal/hub';
import { featureOn } from './unlocks';
import { BALANCE } from './balance';
import { demandIndex, distanceFactor, greatCircleKm } from './demand';
import { destinationDef, type DestinationDef } from './registry';

/**
 * 乗継の計画（フェーズ 4 §5.3、docs/44 §4.2）。
 *
 * 2026-11-19 に「契約の固定率」から「乗継需要モデル」へ変更した:
 * - 到着便ごとに、接続ペア（到着路線 × 出発路線）の潜在需要から乗り継ぐ人数を決める。
 *   需要は出発側目的地の魅力（路線需要モデル D_r の目的地側の要素）と接続品質で決まる。
 * - 契約の transferShare は「その契約が受け入れる乗継の上限（キャップ）」として残す。
 *   実際の乗継割合は cap × A_net / (A_net + localAppeal) で、接続先ネットワークが
 *   無ければ 0、魅力的な接続先が増えるほど上限に近づく（飽和型）。
 * - 配分は便ごとの重み（魅力 × 品質 × 空席）に比例する。地元の旅客（depPax）は減らさない。
 *
 * 決定的: 乱数は便ごとの専用の種だけを使う（従来と同じ種・同じ消費回数）。
 * 結果は到着便の connections と出発便の transferIn に書く。
 */

/**
 * 接続品質 q(gap): 乗継時間 gap に対する需要の残り具合（0〜1）。
 * MCT ぎりぎりは乗り損ね不安で tightQuality まで落ち、MCT + idealBufferMin で 1、
 * それより長い待ちは時定数 decayTauMin の指数減衰（長すぎる接続は需要が落ちる）。
 */
export function connectionQuality(gapSec: number, mctSec: number): number {
  const H = BALANCE.hub;
  const idealSec = mctSec + H.idealBufferMin * 60;
  if (gapSec <= idealSec) {
    const t = idealSec > mctSec ? (gapSec - mctSec) / (idealSec - mctSec) : 1;
    return H.tightQuality + (1 - H.tightQuality) * Math.min(1, Math.max(0, t));
  }
  return Math.exp(-(gapSec - idealSec) / (H.decayTauMin * 60));
}

/**
 * 乗継市場の魅力 A(from → to): 出発地（到着路線の相手都市）から最終目的地への
 * スルー需要の大きさ。路線需要モデル D_r（demand.ts）と同じ重力型で、目的地側の要素
 * （人口^β × 需要指数 I × 国際係数 φ）に、乗継区間の総距離（自空港までの距離 + 先の距離）
 * の減衰 g(d) を掛ける。自空港の人口・アクセス・料金・評価は到着旅客プール側の
 * 大きさ（arrPax）に既に織り込まれているので、ここには入れない。
 *
 * 需要モデル v2（対称重力モデル、domestic_route_demand_realism_plan）との関係:
 * 乗継の魅力は v2 の対象外とし、会社の需要モデル版によらず従来の部品
 * （population 基準・v1 の distanceFactor）のままにする意図的な分離である。
 * 乗継は「自空港を経由するスルー需要」であって OD 潜在需要そのものではなく、
 * v2 の市場ノード（プレイヤー空港の立地市場）とも概念が異なるため、混在ではなく分離として扱う。
 */
export function onwardAppeal(from: DestinationDef, to: DestinationDef): number {
  const M = BALANCE.market;
  const phi = to.scope === 'international' ? M.internationalFactor : 1;
  return Math.pow(to.population / 1e6, M.beta) * demandIndex(to) * distanceFactor(from.distanceKm + to.distanceKm) * phi;
}

/** 2 都市間の直行距離 (km)。目的地の座標（緯度経度）から球面距離で求める（計算式は demand.ts の greatCircleKm が正本で、結果は同一） */
export function directDistanceKm(from: DestinationDef, to: DestinationDef): number {
  return greatCircleKm(from.coordinates, to.coordinates);
}

/**
 * 直行便の魅力 A_nonstop: onwardAppeal と同じ重力型で、経由距離の代わりに
 * 2 都市間の直行距離を使う（仮想の直行経路がどれだけ強い競合か）。
 */
export function nonstopAppeal(from: DestinationDef, to: DestinationDef): number {
  const M = BALANCE.market;
  const phi = to.scope === 'international' ? M.internationalFactor : 1;
  return Math.pow(to.population / 1e6, M.beta) * demandIndex(to) * distanceFactor(directDistanceKm(from, to)) * phi;
}

/**
 * 直行便との競合（F6-17 HubChoiceShare）: その OD のスルー需要のうち、
 * 自空港での乗継が選ばれる割合。直行距離が経由距離より大幅に短い OD では
 * 直行に流れ、迂回が小さい OD では乗継が競合できる。
 */
export function hubChoiceShare(from: DestinationDef, to: DestinationDef): number {
  const via = onwardAppeal(from, to);
  const direct = nonstopAppeal(from, to);
  if (via <= 0 || direct <= 0) return 1;
  return via / (via + BALANCE.hub.nonstopPreference * direct);
}

/** 乗継 OD 集計の 1 行（5A: 表示用データ。能力画面・日報が拾う） */
export interface TransferOdEntry {
  /** 到着路線の相手都市（destinationId） */
  from: string;
  /** 出発路線の相手都市（destinationId） */
  to: string;
  /** 乗継種別（DD / DI / ID / II） */
  kind: ReturnType<typeof transferKindOf>;
  /** 計画乗継人数（その日の計画で配分された人数の合計） */
  pax: number;
  /** 接続ペア数（到着便 × 出発便の組の数） */
  pairs: number;
  /** 魅力 A(from → to)（onwardAppeal。OD で一意なため人数重み平均 = その値） */
  appeal: number;
  /** 接続品質 q の人数重み平均（0〜1） */
  avgQuality: number;
  /** 乗継時間（分）の人数重み平均 */
  avgGapMin: number;
}

/**
 * 乗継 OD 集計（5A）: planConnections が確定した計画（到着便の connections と
 * 出発便の transferIn）を、接続ペア（到着路線 × 出発路線 = OD）ごとに集計する純粋関数。
 *
 * 需要の計算式・配分・乱数は一切変えない。魅力と品質は、計画時に使ったのと同じ
 * 決定的関数（onwardAppeal / connectionQuality）を計画データから再計算して内訳として
 * 添える（乱数は使わない）。合計は Σ connections.pax = Σ transferIn と一致する。
 *
 * 既存の hubStats（実績: spawned / connected / missed / noShow）とは別物で二重計上ではない:
 * こちらは「計画時にどれだけ配分したか」、あちらは「当日実際にどうなったか」。
 * 計画と実績は一致しないのが通常（乗継失敗・ノーショー等）ため、合計も一致を要求しない。
 */
export function summarizeTransferOd(plan: DayPlan, hub: HubAnalysis): TransferOdEntry[] {
  const byKey = new Map(plan.flights.map((f) => [f.key, f]));
  const acc = new Map<string, { from: string; to: string; kind: TransferOdEntry['kind']; pax: number; pairs: number; appealW: number; qualityW: number; gapW: number }>();
  for (const a of plan.flights) {
    if (!a.connections || a.connections.length === 0) continue;
    for (const conn of a.connections) {
      const d = byKey.get(conn.depKey);
      if (!d) continue;
      const mct = hub.mct[conn.kind];
      if (mct === null) continue;
      const gap = d.departureAt - a.arrivalAt;
      const appeal = onwardAppeal(destinationDef(a.destinationId), destinationDef(d.destinationId));
      const quality = connectionQuality(gap, mct);
      const key = `${a.destinationId}|${d.destinationId}|${conn.kind}`;
      const row = acc.get(key) ?? { from: a.destinationId, to: d.destinationId, kind: conn.kind, pax: 0, pairs: 0, appealW: 0, qualityW: 0, gapW: 0 };
      row.pax += conn.pax;
      row.pairs += 1;
      row.appealW += appeal * conn.pax;
      row.qualityW += quality * conn.pax;
      row.gapW += gap * conn.pax;
      acc.set(key, row);
    }
  }
  return [...acc.values()]
    .map((r) => ({
      from: r.from,
      to: r.to,
      kind: r.kind,
      pax: r.pax,
      pairs: r.pairs,
      appeal: r.pax > 0 ? r.appealW / r.pax : 0,
      avgQuality: r.pax > 0 ? r.qualityW / r.pax : 0,
      avgGapMin: r.pax > 0 ? r.gapW / r.pax / 60 : 0,
    }))
    .sort((x, y) => y.pax - x.pax || compareIds(x.from, y.from) || compareIds(x.to, y.to) || compareIds(x.kind, y.kind));
}

/** 接続の上限（分）の既定値（正本。company.hub 未設定のときに使う。表示側もこの値を読む） */
export const DEFAULT_MAX_CONNECT_MIN = 240;

export function planConnections(plan: DayPlan, c: CompanyState, hub: HubAnalysis): void {
  if (!featureOn(c, 'hub')) return;
  const contracts = new Map<string, Contract>(Object.values(c.contracts).map((k) => [k.id, k]));
  const maxConnectSec = (c.hub?.maxConnectMin ?? DEFAULT_MAX_CONNECT_MIN) * 60;
  const intlOn = featureOn(c, 'international');
  const arrivals = [...plan.flights].sort((a, b) => a.arrivalAt - b.arrivalAt || compareIds(a.key, b.key));
  const departures = [...plan.flights].sort((a, b) => a.departureAt - b.departureAt || compareIds(a.key, b.key));

  for (const a of arrivals) {
    if (a.connections) continue; // 同じ計画への二重適用を防ぐ（プレビューと表示で同じ計画を共有するため）
    const ka = contracts.get(a.contractId);
    const cap = ka?.transferShare ?? 0;
    if (cap <= 0 || a.arrPax <= 0) continue;
    const arrIntl = a.routeType === 'international';
    const fromDest = destinationDef(a.destinationId);
    // 候補: MCT 以上 maxConnectMin 以内、同じ航空会社か相互乗継（相手の契約にも乗継の受け入れがある）
    const candidates: { d: PlannedFlight; kind: ReturnType<typeof transferKindOf>; free: number; appealQuality: number }[] = [];
    for (const d of departures) {
      if (d.key === a.key) continue;
      const gap = d.departureAt - a.arrivalAt;
      if (gap <= 0 || gap > maxConnectSec) continue;
      const depIntl = d.routeType === 'international';
      const kind = transferKindOf(arrIntl, depIntl);
      if (kind !== 'DD' && !intlOn) continue;
      const mct = hub.mct[kind];
      if (mct === null || gap < mct) continue;
      const kd = contracts.get(d.contractId);
      if (d.airlineId !== a.airlineId && !((kd?.transferShare ?? 0) > 0)) continue;
      const free = d.seats - d.depPax - (d.transferIn ?? 0);
      if (free <= 0) continue;
      // F6-17 HubChoiceShare: 直行便という比較経路との競合を魅力へ織り込む
      const appealQuality = onwardAppeal(fromDest, destinationDef(d.destinationId)) * hubChoiceShare(fromDest, destinationDef(d.destinationId)) * connectionQuality(gap, mct);
      candidates.push({ d, kind, free, appealQuality });
    }
    if (candidates.length === 0) continue;
    // ネットワーク魅力 A_net: 目的地ごとに最良の（魅力 × 品質）で代表させる。
    // 便の本数で二重に数えない（頻度は配分の重み側で効く）。
    const bestByDest = new Map<string, number>();
    for (const x of candidates) {
      if (x.appealQuality > (bestByDest.get(x.d.destinationId) ?? 0)) bestByDest.set(x.d.destinationId, x.appealQuality);
    }
    let net = 0;
    for (const v of bestByDest.values()) net += v;
    if (net <= 0) continue;
    // 乗継需要の割合: 終着需要（localAppeal）との競合で決まる飽和型。上限は契約のキャップ
    const share = cap * (net / (net + BALANCE.hub.localAppeal));
    const rng = new Rng(`${c.seed}:xfer:${plan.day}:${a.key}`);
    // F6-17 搭乗率への統合: 需要プールは「到着旅客」ではなく「到着便の座席」を基準にする。
    // 搭乗率が低く空席のある便では、スルー需要が空席を埋めて到着便の搭乗率自体が上がる。
    // arrPax が座席を超える計画（あり得る入力）では従来どおり arrPax をプールにする。
    const pool = Math.max(a.arrPax, a.seats);
    const remaining = Math.round(pool * share * (0.9 + 0.2 * rng.next()));
    if (remaining <= 0) continue;
    // 配分: 重み（魅力 × 品質 × 空席）に比例し、端数は魅力 × 品質の大きい順に 1 人ずつ足す。空席は超えない
    const totalFree = candidates.reduce((s, x) => s + x.free, 0);
    const target = Math.min(remaining, totalFree);
    const weights = candidates.map((x) => x.appealQuality * x.free);
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const alloc = candidates.map((x, i) => (totalWeight > 0 ? Math.min(x.free, Math.floor((target * weights[i]!) / totalWeight)) : 0));
    let rest = target - alloc.reduce((s, v) => s + v, 0);
    const order = candidates.map((_, i) => i).sort((i, j) => candidates[j]!.appealQuality - candidates[i]!.appealQuality || compareIds(candidates[i]!.d.key, candidates[j]!.d.key));
    for (const i of order) {
      if (rest <= 0) break;
      const add = Math.min(rest, candidates[i]!.free - alloc[i]!);
      if (add > 0) {
        alloc[i]! += add;
        rest -= add;
      }
    }
    const connections: NonNullable<PlannedFlight['connections']> = [];
    candidates.forEach((x, i) => {
      const pax = alloc[i]!;
      if (pax <= 0) return;
      connections.push({ depKey: x.d.key, pax, kind: x.kind });
      x.d.transferIn = (x.d.transferIn ?? 0) + pax;
    });
    if (connections.length > 0) {
      a.connections = connections;
      // F6-17 搭乗率への統合（続き）: 座席基準プールから配分された乗継が元の到着旅客を
      // 超えた分は、到着便の予約そのものが増えたものとして arrPax を伸ばす（座席が上限）。
      // DayPlan の arrPax は計画段階の需要推定であり、予約確定後の数値ではないため、
      // この伸長は「地元需要の推定 vs スルー需要の配分」の再見積もりとして扱う。
      // 地元終着の人数は arrPax − 乗継合計として従来どおり導出される。
      const allocated = connections.reduce((s, cn) => s + cn.pax, 0);
      if (a.seats > a.arrPax) a.arrPax = Math.max(a.arrPax, Math.min(allocated, a.seats));
    }
  }
}
