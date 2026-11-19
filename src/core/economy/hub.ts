import { Rng } from '../rng';
import { compareIds } from '../model/ids';
import type { CompanyState, Contract } from './company';
import type { DayPlan, PlannedFlight } from './planning';
import { transferKindOf, type HubAnalysis } from '../terminal/hub';
import { featureOn } from './unlocks';
import { BALANCE } from './balance';
import { demandIndex, distanceFactor } from './demand';
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
 */
export function onwardAppeal(from: DestinationDef, to: DestinationDef): number {
  const M = BALANCE.market;
  const phi = to.scope === 'international' ? M.internationalFactor : 1;
  return Math.pow(to.population / 1e6, M.beta) * demandIndex(to) * distanceFactor(from.distanceKm + to.distanceKm) * phi;
}

export function planConnections(plan: DayPlan, c: CompanyState, hub: HubAnalysis): void {
  if (!featureOn(c, 'hub')) return;
  const contracts = new Map<string, Contract>(Object.values(c.contracts).map((k) => [k.id, k]));
  const maxConnectSec = (c.hub?.maxConnectMin ?? 240) * 60;
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
      const appealQuality = onwardAppeal(fromDest, destinationDef(d.destinationId)) * connectionQuality(gap, mct);
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
    const remaining = Math.round(a.arrPax * share * (0.9 + 0.2 * rng.next()));
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
    if (connections.length > 0) a.connections = connections;
  }
}
