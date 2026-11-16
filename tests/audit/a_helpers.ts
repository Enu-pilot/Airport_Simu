/**
 * 監査 a 系（docs/38 ID 01–07）の共通ヘルパ。テスト専用。src/ は変更しない。
 */
import { checkInvariants } from '../../src/core/sim/invariants';
import { stepSimulation, type Simulation } from '../../src/core/sim/simulation';
import { GROUND_MOVING_STATES, TERMINAL_STATES, type Aircraft } from '../../src/core/sim/types';

/** 状態ごとの滞在時間の上限（秒）。超えたら「停滞」とみなす（待機系は長めに取る） */
export const STATE_AGE_LIMIT_SEC: Partial<Record<Aircraft['state'], number>> = {
  landing: 600,
  vacating: 900,
  taxiIn: 2400,
  docking: 600,
  pushback: 600,
  taxiOut: 2400,
  lineUp: 600,
  takeoff: 600,
  departed: 600,
  approach: 900,
};

export interface WatchResult {
  violations: string[];
  /** 1 ティックで動いた最大距離（m、地上移動中のみ） */
  maxStepM: number;
  /** 停滞（STATE_AGE_LIMIT_SEC 超過）の記録 */
  stuck: string[];
  /** 同時にスポットを占有した機体数の最大値（同一スポット） */
  maxStandOwners: number;
  /** 観測した（機体 id → 状態遷移列） */
  seq: Record<string, string[]>;
}

export interface WatchOptions {
  /** checkInvariants を呼ぶ間隔（tick） */
  every?: number;
  /** 各 tick の後に呼ぶ（障害の注入など）。tick 番号（0 始まり）を渡す */
  onTick?: (sim: Simulation, i: number) => void;
}

/**
 * sim を seconds 秒進めながら、不変条件（every ティックごと）・位置の連続性（毎ティック）・状態滞在時間・スポット二重占有を監視する。
 * 違反は例外にせず記録して返す（テスト側で seed 付きのメッセージとともに expect する）。
 */
export function runWatched(sim: Simulation, seconds: number, opts: WatchOptions = {}): WatchResult {
  const every = opts.every ?? 5;
  const res: WatchResult = { violations: [], maxStepM: 0, stuck: [], maxStandOwners: 0, seq: {} };
  const prev = new Map<string, { x: number; y: number; state: string }>();
  const stuckSeen = new Set<string>();
  for (let i = 0; i < seconds; i++) {
    stepSimulation(sim);
    opts.onTick?.(sim, i);
    const owners = new Map<string, number>();
    for (const ac of Object.values(sim.state.aircraft)) {
      const seq = (res.seq[ac.id] ??= []);
      if (seq[seq.length - 1] !== ac.state) seq.push(ac.state);
      if (ac.standId && !TERMINAL_STATES.includes(ac.state)) owners.set(ac.standId, (owners.get(ac.standId) ?? 0) + 1);
      const p = prev.get(ac.id);
      if (p && GROUND_MOVING_STATES.includes(ac.state) && GROUND_MOVING_STATES.includes(p.state as Aircraft['state']) && p.state === ac.state) {
        const d = Math.hypot(ac.x - p.x, ac.y - p.y) * 25;
        if (d > res.maxStepM) res.maxStepM = d;
      }
      prev.set(ac.id, { x: ac.x, y: ac.y, state: ac.state });
      const lim = STATE_AGE_LIMIT_SEC[ac.state];
      if (lim !== undefined && !TERMINAL_STATES.includes(ac.state) && sim.state.now - ac.stateSince > lim && ac.holdReason === null) {
        const key = `${ac.id} ${ac.state}`;
        if (!stuckSeen.has(key)) {
          stuckSeen.add(key);
          res.stuck.push(`${key} ${sim.state.now - ac.stateSince}s @t=${sim.state.now}`);
        }
      }
    }
    for (const n of owners.values()) res.maxStandOwners = Math.max(res.maxStandOwners, n);
    if (i % every === 0) {
      const v = checkInvariants(sim);
      for (const m of v) if (res.violations.length < 20) res.violations.push(`t=${sim.state.now}: ${m}`);
    }
  }
  return res;
}

/** 全機が終端状態（departed 等）か未出現 */
export const allSettled = (sim: Simulation): boolean =>
  Object.values(sim.state.aircraft).every((a) => a.state === 'scheduled' || TERMINAL_STATES.includes(a.state));

export const active = (sim: Simulation): Aircraft[] =>
  Object.values(sim.state.aircraft).filter((a) => a.state !== 'scheduled' && !TERMINAL_STATES.includes(a.state));
