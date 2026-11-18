import { BALANCE } from '../economy/balance';
import type { Simulation } from './simulation';

/**
 * フェーズ 4 の不変条件（docs/design/impl_phase4_plan.md §7.1）。
 * 新機能の項目があるときだけ検査する。各ブロックの実装に合わせて検査を足す。
 * checkInvariants から呼ばれる。
 */
export function checkPhase4Invariants(sim: Simulation, full: boolean): string[] {
  const problems: string[] = [];
  const s = sim.state;
  // 毎ティック用（full でない）ときは処理中の便・グループ・手荷物だけを見る（履歴は日をまたいで蓄積するので、
  // 全件走査すると 1 日の計算が履歴の長さに比例して重くなる。本体の checkInvariants と同じ方針）
  const flightList = full
    ? Object.values(s.flights)
    : [...new Set(Object.values(s.aircraft).flatMap((ac) => [ac.arrivalFlightId, ac.departureFlightId]))]
        .map((id) => s.flights[id])
        .filter((f) => f !== undefined);
  const groupList = (full ? Object.keys(s.paxGroups) : s.activePax).map((id) => s.paxGroups[id]).filter((g) => g !== undefined);
  const bagList = (full ? Object.keys(s.bags) : s.activeBags).map((id) => s.bags[id]).filter((b) => b !== undefined);
  // O1: 置き直した機体はちょうど 1 つのスポットを占有し、合成の到着便は旅客・手荷物を持たない
  for (const f of flightList) {
    if (!f.carryOver) continue;
    if (f.pax.booked !== 0 || f.pax.deplaned !== 0) problems.push(`O1: 合成の到着便 ${f.id} が旅客を持っています`);
    // 占有の一致は「そのスポットにまだいる間」だけを見る。離陸済み（standId なし）やスポット変更後は記録側が古いだけ
    const ac = f.aircraftId ? s.aircraft[f.aircraftId] : undefined;
    if (ac && ac.standId !== null && ac.standId === f.standId && s.standAssignments[f.standId ?? ''] !== f.aircraftId) {
      problems.push(`O1: 置き直した機体 ${f.aircraftId} のスポット占有が一致しません`);
    }
  }
  // O2: techHoldUntil より前にプッシュバックしていない
  for (const f of flightList) {
    if (f.techHoldUntil !== undefined && f.block !== null && f.block < f.techHoldUntil) {
      problems.push(`O2: 便 ${f.id} が整備の保留より前にプッシュバックしています`);
    }
  }
  // C1: 国際出発区域にいる出発グループ（出国審査エリアの中にいる間を除く）は出国審査を通過済み
  // C2: 国際到着便から退出したグループは入国審査と税関を通過済み
  // C3: 国内便の通常グループは国際区域に入らない（乗継グループは到着側の区域を通るので除く）
  const areas = sim.ctx.terminal.areas;
  for (const g of groupList) {
    const f = s.flights[g.flightId];
    const area = g.area ? areas[g.area] : undefined;
    const zone = area?.zone;
    if (g.direction === 'departure' && zone === 'departureIntl' && area?.kind !== 'emigration' && !g.ciq?.emigration) {
      problems.push(`C1: グループ ${g.id} が出国審査を通らずに国際出発区域にいます`);
    }
    if (g.state === 'exited' && g.direction === 'arrival' && f?.routeType === 'international' && !(g.ciq?.immigration && g.ciq?.customs)) {
      problems.push(`C2: グループ ${g.id} が入国審査・税関を通らずに退出しました`);
    }
    if (f && f.routeType !== 'international' && !g.transfer && (zone === 'departureIntl' || zone === 'arrivalIntl')) {
      problems.push(`C3: 国内便のグループ ${g.id} が国際区域にいます`);
    }
  }
  // T1: 到着便の transferOut は、その便から出た乗継グループの人数と一致する
  // T2: 乗継グループは一般区域にいず、アクセスを使わず、toAirport にならない
  // T3: 出発便の transferIn は、その便の乗継グループの人数と一致する
  for (const f of flightList) {
    // 乗継の項目がある便だけグループを引く（毎ティック呼ばれるため、対象外の便で配列を作らない）
    const isArr = f.direction === 'arrival' && f.pax.transferOut !== undefined;
    const isDep = f.direction === 'departure' && f.pax.transferIn !== undefined;
    if (!isArr && !isDep) continue;
    const groups = (s.flightPax[f.id] ?? []).map((id) => s.paxGroups[id]!).filter(Boolean);
    if (isArr) {
      const sum = groups.filter((g) => g.transfer?.fromFlightId === f.id).reduce((n, g) => n + g.count, 0);
      if (sum !== f.pax.transferOut) problems.push(`T1: 便 ${f.id} の transferOut ${f.pax.transferOut} ≠ 乗継グループ合計 ${sum}`);
    }
    if (isDep) {
      const sum = groups.filter((g) => g.transfer && g.flightId === f.id).reduce((n, g) => n + g.count, 0);
      if (sum !== f.pax.transferIn) problems.push(`T3: 便 ${f.id} の transferIn ${f.pax.transferIn} ≠ 乗継グループ合計 ${sum}`);
    }
  }
  for (const g of groupList) {
    if (!g.transfer) continue;
    if (g.accessDone !== true) problems.push(`T2: 乗継グループ ${g.id} が accessDone を持っていません`);
    if (g.state === 'toAirport') problems.push(`T2: 乗継グループ ${g.id} が toAirport になっています`);
    const area = g.area ? areas[g.area] : undefined;
    if (area?.zone === 'landside') problems.push(`T2: 乗継グループ ${g.id} が一般区域にいます`);
  }
  // B1: 乗継手荷物の付け替えは 1 回だけ。付け替え後は出発便の手荷物になっている
  for (const b of bagList) {
    if (!b.transferFromFlightId) continue;
    if (b.transferToFlightId) problems.push(`B1: 手荷物 ${b.id} に付け替え先が残っています`);
    if (b.direction !== 'departure' || b.flightId === b.transferFromFlightId) problems.push(`B1: 手荷物 ${b.id} の付け替えが不完全です`);
    const marks = b.history.filter((h) => h.location.startsWith('transfer:')).length;
    if (marks > 1) problems.push(`B1: 手荷物 ${b.id} が ${marks} 回付け替えられています`);
  }
  // E1: 区間モデルでは、区間の毎時の台数は 0 以上で有限。遅れは有限で上限以下
  const acc = s.access;
  if (acc?.segments) {
    for (const [key, v] of Object.entries(acc.hourly)) {
      if (!key.startsWith('seg:')) continue;
      if (!Number.isFinite(v) || v < 0) problems.push(`E1: 区間の毎時台数 ${key} = ${v} が不正です`);
    }
    const cap = BALANCE.accessModel.congestionMaxMin;
    for (const [label, sum, n] of [['道路', acc.stats.roadDelaySum, acc.stats.roadDelayN], ['車寄せ', acc.stats.curbDelaySum, acc.stats.curbDelayN]] as const) {
      if (!Number.isFinite(sum) || sum < 0) problems.push(`E1: ${label}の遅れ合計 ${sum} が不正です`);
      else if (n > 0 && sum / n > cap + 1e-9) problems.push(`E1: ${label}の平均遅れ ${sum / n} が上限 ${cap} を超えています`);
    }
  }
  return problems;
}
