import type { Simulation } from '../sim/simulation';
import { WALK_SPEED_MPS } from './model';
import { PAX_FINAL_STATES, type PaxGroup, type PaxStep } from '../sim/types';

export type PassengerFlowSeverity = 'critical' | 'warning';

export interface PassengerFlowIssue {
  key: string;
  severity: PassengerFlowSeverity;
  terminalId: string | null;
  targetId: string | null;
  flightIds: string[];
  pax: number;
  stage: string;
  reason: string;
  recommendation: string;
  since: number;
}

const observedWaits = new WeakMap<object, Map<string, { state: string; stage: string; target: string | null; since: number; progress?: number; lastProgressAt?: number }>>();

const STAGE_LABEL: Record<PaxStep, string> = {
  checkIn: 'チェックイン',
  security: '保安検査',
  shop: '店舗',
  restroom: 'トイレ',
  gate: '搭乗口',
  claim: '手荷物受取',
  exit: '出口',
};

/**
 * 実運用中の旅客状態から、動線異常だけを集約する。
 * 通常の待ち列は異常にせず、構造上の到達不能・ターミナル越境は即時、
 * 施設待ち・処理待ちは累計待ちが長い場合だけ警告する。
 */
export function passengerFlowIssues(sim: Simulation): PassengerFlowIssue[] {
  const { state, ctx } = sim;
  const found = new Map<string, PassengerFlowIssue>();
  const waits = observedWaits.get(state) ?? new Map<string, { state: string; stage: string; target: string | null; since: number; progress?: number; lastProgressAt?: number }>();
  observedWaits.set(state, waits);
  const add = (g: PaxGroup, severity: PassengerFlowSeverity, stage: string, targetId: string | null, reason: string, recommendation: string, since = state.now) => {
    const key = `paxFlow:${g.terminalId ?? 'unassigned'}:${stage}:${targetId ?? 'none'}:${reason}`;
    const old = found.get(key);
    if (old) {
      old.pax += g.count;
      if (!old.flightIds.includes(g.flightId)) old.flightIds.push(g.flightId);
      old.since = Math.min(old.since, since);
    } else found.set(key, { key, severity, terminalId: g.terminalId, targetId, flightIds: [g.flightId], pax: g.count, stage, reason, recommendation, since });
  };

  for (const id of state.activePax) {
    const g = state.paxGroups[id]!;
    if (PAX_FINAL_STATES.includes(g.state) || g.state === 'toAirport') continue;
    const step = g.steps[g.stepIndex];
    const stage = step ? STAGE_LABEL[step] : '旅客処理';
    const area = g.area ? ctx.terminal.areas[g.area] : undefined;
    const stepTarget = step === 'gate'
      ? state.flights[g.flightId]?.pax.gateId ?? null
      : step === 'claim'
        ? state.flights[g.flightId]?.pax.claimAreaId ?? null
        : step === 'exit'
          ? (ctx.terminal.byTerminal[g.terminalId ?? ''] ?? []).find((id) => ctx.terminal.areas[id]!.kind === 'exit') ?? null
          : step
            ? (ctx.terminal.byTerminal[g.terminalId ?? ''] ?? []).find((id) => ctx.terminal.areas[id]!.kind === ({ checkIn: 'checkIn', security: 'security', restroom: 'restroom', shop: 'shop' } as const)[step as 'checkIn' | 'security' | 'restroom' | 'shop']) ?? null
            : null;
    if (!g.terminalId) {
      add(g, 'critical', stage, null, '旅客のターミナルが割り当てられていません', '便の到着ゲートまたは出発ゲートをターミナルに接続してください');
      continue;
    }
    if ((area && area.terminalId !== g.terminalId) || g.route.some((routeId) => ctx.terminal.areas[routeId]?.terminalId !== g.terminalId)) {
      add(g, 'critical', stage, g.area, '割り当てと異なるターミナルへの経路が検出されました', '便のゲート接続先とターミナル内の通路を確認してください');
      continue;
    }
    const flight = state.flights[g.flightId];
    const assignedGate = g.direction === 'departure' ? flight?.pax.gateId ?? null : null;
    const gateTerminal = assignedGate ? ctx.terminal.gates[assignedGate]?.terminalId : null;
    if (g.direction === 'departure' && gateTerminal && gateTerminal !== g.terminalId) {
      add(g, 'critical', '搭乗口', assignedGate, '搭乗口変更後のターミナルが旅客の割当てと異なります', '同一ターミナル内の搭乗口へ戻すか、ターミナル間移動設備を整備してください');
      continue;
    }
    if (g.state === 'stranded') {
      const target = step === 'gate' ? flight?.pax.gateId ?? null : g.facility ?? g.area;
      add(g, 'critical', stage, target, '利用可能な経路がありません', '同じターミナル内で工程間を接続し、施設の閉鎖・処理窓口数を確認してください');
      continue;
    }
    if (g.state === 'walking') {
      const target = g.route[0] ?? null;
      if (!target) {
        add(g, 'critical', stage, g.area, '移動中ですが次の経路区間がありません', '工程間の通路接続を確認し、旅客を再経路探索できる状態にしてください');
        continue;
      }
      const previous = waits.get(g.id);
      const progress = g.walkSec + g.legProgress;
      const current = previous && previous.state === g.state && previous.stage === stage && previous.target === target
        ? previous
        : { state: g.state, stage, target, since: state.now, progress, lastProgressAt: state.now };
      if (current.progress !== progress) {
        current.progress = progress;
        current.lastProgressAt = state.now;
      }
      waits.set(g.id, current);
      const expectedLegSec = g.legLength / WALK_SPEED_MPS;
      const threshold = Math.max(10 * 60, expectedLegSec * 2 + 5 * 60);
      if (state.now - (current.lastProgressAt ?? state.now) >= threshold) {
        add(g, 'warning', stage, target, '移動距離に対して長時間進捗がありません', '通路の閉鎖状態・次区間の接続・旅客位置を確認してください', current.lastProgressAt ?? state.now);
      }
      continue;
    }
    const waitStates = ['waitingFacility', 'queuing', 'boardingQueue', 'waitingBaggage'];
    const target = g.state === 'waitingFacility' ? stepTarget : g.facility ?? g.area;
    if (waitStates.includes(g.state)) {
      const previous = waits.get(g.id);
      const current = previous && previous.state === g.state && previous.stage === stage && previous.target === target
        ? previous
        : { state: g.state, stage, target, since: state.now };
      waits.set(g.id, current);
      const elapsed = state.now - current.since;
      if (g.state === 'waitingFacility' && elapsed >= 15 * 60) {
        add(g, 'warning', stage, target, '利用可能な施設を15分以上待ち続けています', '施設を再開するか、同じターミナルに処理能力のある代替施設を追加してください', current.since);
        continue;
      }
      if ((g.state === 'queuing' || g.state === 'boardingQueue' || g.state === 'waitingBaggage') && elapsed >= 20 * 60) {
        add(g, 'warning', stage, target, '工程の待ち時間が20分を超えています', '該当施設の窓口数・人員・ベルト数と便の集中を確認してください', current.since);
        continue;
      }
    } else {
      waits.delete(g.id);
    }
    const f = state.flights[g.flightId];
    if (g.state === 'boardingQueue' && f?.pax.gateId && state.closures.gates.includes(f.pax.gateId)) {
      add(g, 'critical', '搭乗口', f.pax.gateId, '搭乗口が閉鎖されています', 'ゲートを復旧するか便のスポットを再割当てしてください');
    }
  }

  return [...found.values()].map((x) => ({ ...x, flightIds: x.flightIds.sort() })).sort((a, b) => a.severity === b.severity ? a.key.localeCompare(b.key) : a.severity === 'critical' ? -1 : 1);
}
