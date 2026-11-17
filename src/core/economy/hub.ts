import { Rng } from '../rng';
import { compareIds } from '../model/ids';
import type { CompanyState, Contract } from './company';
import type { DayPlan, PlannedFlight } from './planning';
import { transferKindOf, type HubAnalysis } from '../terminal/hub';
import { featureOn } from './unlocks';

/**
 * 乗継の計画（フェーズ 4 §5.3）。決定的: 乱数は便ごとの専用の種だけを使う。
 * 乗継は出発便の空席を埋めるだけで、地元の旅客（depPax）は減らさない。
 * 結果は到着便の connections と出発便の transferIn に書く。
 */
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
    const share = ka?.transferShare ?? 0;
    if (share <= 0 || a.arrPax <= 0) continue;
    const rng = new Rng(`${c.seed}:xfer:${plan.day}:${a.key}`);
    const remaining = Math.round(a.arrPax * share * (0.9 + 0.2 * rng.next()));
    if (remaining <= 0) continue;
    const arrIntl = a.routeType === 'international';
    // 候補: MCT 以上 maxConnectMin 以内、同じ航空会社か相互乗継（両契約に transferShare）
    const candidates: { d: PlannedFlight; kind: ReturnType<typeof transferKindOf>; free: number }[] = [];
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
      candidates.push({ d, kind, free });
    }
    if (candidates.length === 0) continue;
    // 空席に比例して配り、端数は先頭から 1 人ずつ足す。空席は超えない
    const totalFree = candidates.reduce((s, x) => s + x.free, 0);
    const target = Math.min(remaining, totalFree);
    const alloc = candidates.map((x) => Math.min(x.free, Math.floor((target * x.free) / totalFree)));
    let rest = target - alloc.reduce((s, x) => s + x, 0);
    for (let i = 0; rest > 0 && i < alloc.length; i++) {
      const add = Math.min(rest, candidates[i]!.free - alloc[i]!);
      alloc[i]! += add;
      rest -= add;
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
