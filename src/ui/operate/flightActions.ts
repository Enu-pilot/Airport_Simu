import { checkStand } from '../../core/aircraft/compat';
import { resolveType } from '../../core/sim/aircraftTypes';
import type { Simulation } from '../../core/sim/simulation';
import type { Stand } from '../../core/model/types';
import { displayName } from '../../i18n/ja';

/** 着陸前の到着機だけがスポット変更の対象（core/sim/disruptions.ts の reassignStand と同じ条件） */
export function canReassignStand(sim: Simulation, acId: string): boolean {
  const ac = sim.state.aircraft[acId];
  return !!ac && (ac.state === 'scheduled' || ac.state === 'inbound' || ac.state === 'holding');
}

/** 機種に適合するスポット（aircraft/compat.ts の判定）。運航表の行メニューと機体の詳細の「代替スポット」が共有する */
export function compatibleStands(sim: Simulation, acId: string): Stand[] {
  const ac = sim.state.aircraft[acId];
  if (!ac) return [];
  const type = resolveType(sim.ctx.types, ac.typeId);
  return Object.values(sim.ctx.layout.stands).filter((s) => checkStand(type, s, sim.ctx.network).status === 'ok');
}

/** 選択肢の表示名（閉鎖中・使用中の注記つき） */
export function standOptionLabel(sim: Simulation, standId: string): { text: string; closed: boolean } {
  const { state, ctx } = sim;
  const closed = state.closures.stands.includes(standId);
  return { text: `${displayName(ctx.layout, standId)}${closed ? '（閉鎖中）' : state.standAssignments[standId] ? '（使用中）' : ''}`, closed };
}
