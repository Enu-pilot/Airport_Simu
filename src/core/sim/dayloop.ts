import { DAY_SEC, INBOUND_LEAD_SEC } from './rules';
import { stepSimulation, type Simulation } from './simulation';

/**
 * 1 日のループの読み取り補助（docs/14_management_rules.md §N「日のループ」）。
 *
 * シミュレーションの状態を変えるのは stepSimulation だけで、ここの関数はそれを繰り返し呼び、各 tick の後で
 * 停止条件を「読む」だけ。ライブ運航（フレームごとに k 回）と 1 日スキップ（チャンクごとに m 回）が
 * 同じ関数を同じ順に同じ回数だけ適用するので、止まる位置が同じなら結果は完全に一致する。
 */

/** 締めの検出に使う印。会社があれば company.day（締めるたびに +1）、なければ日付 */
export function dayMarker(sim: Simulation): number {
  return sim.company ? sim.company.day : Math.floor((sim.state.now - 1) / DAY_SEC);
}

export interface StepResult {
  /** 実際に進めた tick 数 */
  ticks: number;
  /** 止まった理由（maxTicks を使い切ったときは null） */
  stop: 'dayClose' | 'predicate' | 'bankrupt' | null;
}

export interface StepOptions {
  /** 日次の締め（0:00）を行った tick の直後で止める */
  stopAtDayClose?: boolean;
  /** 各 tick の後に調べる止める条件（読み取りのみ。シミュレーションを変更してはならない） */
  stopWhen?: (sim: Simulation) => boolean;
}

/** 最大 maxTicks 進める。経営破綻・締め・条件のいずれかで、その tick の直後に止まる */
export function stepTicks(sim: Simulation, maxTicks: number, opts: StepOptions = {}): StepResult {
  const marker = dayMarker(sim);
  for (let i = 1; i <= maxTicks; i++) {
    stepSimulation(sim);
    if (sim.company?.bankrupt) return { ticks: i, stop: 'bankrupt' };
    if (opts.stopAtDayClose && dayMarker(sim) !== marker) return { ticks: i, stop: 'dayClose' };
    if (opts.stopWhen?.(sim)) return { ticks: i, stop: 'predicate' };
  }
  return { ticks: Math.max(0, maxTicks), stop: null };
}

/** 次の締め（0:00）の時刻（ゲーム内の秒）。now が 0:00 ちょうどなら次の日の 0:00 */
export function nextCloseAt(sim: Simulation): number {
  return (Math.floor(sim.state.now / DAY_SEC) + 1) * DAY_SEC;
}

/**
 * 重大な障害の検出（1 日スキップの自動停止）。作った時点の状態を基準に、その後に
 * 「滑走路の閉鎖・整備が始まった」「ダイバートが増えた」を検出する。状態は読むだけ（基準は閉包に持つ）。
 */
export function majorDisruptionWatcher(sim: Simulation): (sim: Simulation) => boolean {
  const known = new Set(sim.state.disruptions.map((d) => d.id));
  let diverted = sim.state.stats.diverted;
  return (s) => {
    const st = s.state;
    if (st.stats.diverted > diverted) {
      diverted = st.stats.diverted;
      return true;
    }
    for (const d of st.disruptions) {
      if (known.has(d.id)) continue;
      known.add(d.id);
      if (d.status === 'resolved') continue;
      if (d.kind === 'runwayClosed' || (d.kind === 'maintenance' && d.targetId !== null && st.runways[d.targetId] !== undefined)) return true;
    }
    return false;
  };
}

/**
 * 締めの直後の夜間を早送りする終点（ゲーム内の秒）。次の到着機が現れる 10 分前（到着の 15 分前に現れる）、
 * 便がなければ開場の 30 分前。次の締めを越えない。夜間は便がなく何も起きないが、早送りも通常と同じ stepSimulation の繰り返しで、
 * 画面で待つ時間を省くだけ（結果は同じ）。
 */
export function nightEndAt(sim: Simulation): number {
  const { state } = sim;
  const close = nextCloseAt(sim);
  let t = Number.POSITIVE_INFINITY;
  for (const f of Object.values(state.flights)) {
    if (f.direction === 'arrival' && f.status === 'scheduled' && f.estimated > state.now) t = Math.min(t, f.estimated - INBOUND_LEAD_SEC - 600);
  }
  if (!Number.isFinite(t)) t = (close - DAY_SEC) + (sim.company?.hours.openMin ?? 360) * 60 - 1800;
  return Math.max(state.now, Math.min(t, close));
}
